"""外部因子注册与按日期广播物化。"""
from __future__ import annotations

import logging
from datetime import date
from pathlib import Path

import polars as pl

from .models import EXTERNAL_FACTOR_PREFIX, ExternalFactorDefinition, to_factor_spec
from .store import ExternalFactorStore

logger = logging.getLogger(__name__)
_sync_state: tuple | None = None


def _resolve_dir(data_dir: Path | None) -> Path:
    if data_dir is not None:
        return Path(data_dir)
    from app.config import settings

    return Path(settings.data_dir)


def _definitions(root: Path) -> list[ExternalFactorDefinition]:
    return ExternalFactorStore(root).load_all()


def ensure_synced(data_dir: Path | None = None) -> None:
    """将独立定义惰性注册到统一因子注册表。"""
    global _sync_state
    root = _resolve_dir(data_dir)
    store = ExternalFactorStore(root)
    key = (str(root), store.signature())
    if _sync_state == key:
        return

    from app.factors.registry import _REGISTRY, register_factor, unregister_factor

    definitions = _definitions(root)
    desired = {item.id: item for item in definitions}
    for factor_id in [
        factor_id for factor_id in list(_REGISTRY)
        if factor_id.startswith(EXTERNAL_FACTOR_PREFIX)
    ]:
        try:
            unregister_factor(factor_id)
        except ValueError:
            logger.warning("external factor unregister failed: %s", factor_id)

    pending = list(desired.values())
    for _ in range(len(pending) + 1):
        deferred: list[ExternalFactorDefinition] = []
        for definition in pending:
            try:
                spec = to_factor_spec(definition)
            except ValueError:
                deferred.append(definition)
                continue
            register_factor(spec)
        if not deferred:
            break
        pending = deferred
    for definition in pending:
        logger.warning("external factor registration skipped %s", definition.id)
    _sync_state = key


def invalidate(data_dir: Path | None = None) -> None:
    global _sync_state
    root = _resolve_dir(data_dir)
    if _sync_state is not None and _sync_state[0] == str(root):
        _sync_state = None


def external_factor_ids(data_dir: Path | None = None) -> frozenset[str]:
    root = _resolve_dir(data_dir)
    ensure_synced(root)
    return frozenset(item.id for item in _definitions(root))


def external_factor_dependencies(
    names: set[str] | list[str] | tuple[str, ...],
    data_dir: Path | None = None,
) -> frozenset[str]:
    """返回外部定义依赖的内部因子; 外部依赖继续递归展开。"""
    root = _resolve_dir(data_dir)
    ensure_synced(root)
    definitions = {item.id: item for item in _definitions(root)}
    resolved: set[str] = set()
    visiting: set[str] = set()

    def visit(name: str) -> None:
        if name in visiting:
            return
        definition = definitions.get(name)
        if definition is None or definition.operation != "difference":
            if definition is None:
                resolved.add(name)
            return
        visiting.add(name)
        for dependency in (definition.left_factor_id, definition.right_factor_id):
            if not dependency:
                continue
            if dependency in definitions:
                visit(dependency)
            else:
                resolved.add(dependency)
        visiting.remove(name)

    for name in names:
        visit(str(name))
    return frozenset(resolved)


def _partition_paths(base: Path) -> list[tuple[date, Path]]:
    if not base.exists():
        return []
    paths: list[tuple[date, Path]] = []
    for directory in sorted(base.glob("date=*")):
        part = directory / "part.parquet"
        if not part.exists():
            continue
        try:
            day = date.fromisoformat(directory.name[5:])
        except ValueError:
            continue
        paths.append((day, part))
    return paths


def _collapse_broadcast(rows: list[pl.DataFrame]) -> pl.DataFrame:
    if not rows:
        return pl.DataFrame({"__ef_date": [], "__ef_value": []}, schema={
            "__ef_date": pl.Date, "__ef_value": pl.Float64,
        })
    frame = pl.concat(rows, how="vertical_relaxed")
    frame = frame.filter(
        pl.col("__ef_value").is_not_null() & pl.col("__ef_value").is_finite()
    )
    if frame.is_empty():
        return frame
    grouped = frame.group_by("__ef_date").agg(
        pl.col("__ef_value").unique().alias("__ef_values")
    )
    if grouped.filter(pl.col("__ef_values").list.len() > 1).height:
        raise ValueError("同一日期存在多个不同值, 不能安全按日期广播")
    return grouped.select(
        "__ef_date",
        pl.col("__ef_values").list.first().alias("__ef_value"),
    ).sort("__ef_date")


def _read_index_source(root: Path, definition: ExternalFactorDefinition) -> pl.DataFrame:
    rows: list[pl.DataFrame] = []
    for day, path in _partition_paths(root / "kline_index_daily"):
        try:
            raw = pl.read_parquet(path)
        except Exception as exc:
            logger.warning("index source read failed %s: %s", path, exc)
            continue
        if "symbol" not in raw.columns or definition.source_field not in raw.columns:
            continue
        hit = raw.filter(pl.col("symbol").cast(pl.String) == definition.source_symbol)
        if hit.is_empty():
            continue
        date_expr = (
            pl.col("date").cast(pl.Date, strict=False)
            if "date" in hit.columns
            else pl.lit(day, dtype=pl.Date)
        )
        rows.append(hit.select([
            date_expr.alias("__ef_date"),
            pl.col(definition.source_field).cast(pl.Float64, strict=False).alias("__ef_value"),
        ]))
    return _collapse_broadcast(rows)


def _read_ext_source(root: Path, definition: ExternalFactorDefinition) -> pl.DataFrame:
    from app.services.ext_data import ExtConfigStore

    config = ExtConfigStore(root).get(definition.source_config_id or "")
    if config is None or config.mode != "timeseries":
        raise ValueError("扩展数据来源不存在或不是 timeseries")
    rows: list[pl.DataFrame] = []
    for day, path in _partition_paths(root / "ext_data" / config.id / "timeseries"):
        try:
            raw = pl.read_parquet(path, columns=[definition.source_field])
        except Exception as exc:
            logger.warning("external source read failed %s: %s", path, exc)
            continue
        rows.append(raw.select([
            pl.lit(day, dtype=pl.Date).alias("__ef_date"),
            pl.col(definition.source_field).cast(pl.Float64, strict=False).alias("__ef_value"),
        ]))
    return _collapse_broadcast(rows)


def _direct_values(root: Path, definition: ExternalFactorDefinition) -> pl.DataFrame:
    if definition.source_type == "index_daily":
        values = _read_index_source(root, definition)
        if values.is_empty() or definition.transform != "return":
            return values
        return values.with_columns(
            (pl.col("__ef_value") / pl.col("__ef_value").shift(definition.window) - 1.0)
            .alias("__ef_value")
        ).drop_nulls("__ef_value")
    return _read_ext_source(root, definition)


def _attach_one(
    frame: pl.DataFrame,
    name: str,
    definitions: dict[str, ExternalFactorDefinition],
    root: Path,
    visiting: set[str],
) -> pl.DataFrame:
    if name in frame.columns:
        return frame
    definition = definitions.get(name)
    if definition is None or name in visiting:
        return frame.with_columns(pl.lit(None).cast(pl.Float64).alias(name))
    visiting.add(name)
    try:
        if definition.operation == "difference":
            dependencies = [definition.left_factor_id, definition.right_factor_id]
            for dependency in dependencies:
                if dependency in definitions:
                    frame = _attach_one(frame, dependency, definitions, root, visiting)
            if all(dependency and dependency in frame.columns for dependency in dependencies):
                frame = frame.with_columns(
                    (pl.col(dependencies[0]) - pl.col(dependencies[1])).alias(name)
                )
            else:
                frame = frame.with_columns(pl.lit(None).cast(pl.Float64).alias(name))
        else:
            values = _direct_values(root, definition)
            if values.is_empty() or "date" not in frame.columns:
                return frame.with_columns(pl.lit(None).cast(pl.Float64).alias(name))
            prepared = frame.with_columns(
                pl.col("date").cast(pl.Date, strict=False).alias("__ef_date")
            )
            frame = prepared.join(values.select([
                "__ef_date", pl.col("__ef_value").alias(name),
            ]), on="__ef_date", how="left").drop("__ef_date")
    except Exception as exc:
        logger.warning("external factor %s attach failed: %s", name, exc)
        if name not in frame.columns:
            frame = frame.with_columns(pl.lit(None).cast(pl.Float64).alias(name))
    finally:
        visiting.remove(name)
    return frame


def attach_external_factors(
    frame: pl.DataFrame,
    names: set[str] | list[str] | tuple[str, ...],
    data_dir: Path | None = None,
) -> pl.DataFrame:
    """把指定外部因子按日期广播到面板; 缺失/歧义来源 fail-closed 为 null。"""
    if frame.is_empty() or "date" not in frame.columns:
        return frame
    root = _resolve_dir(data_dir)
    ensure_synced(root)
    definitions = {item.id: item for item in _definitions(root)}
    for name in names:
        frame = _attach_one(frame, str(name), definitions, root, set())
    return frame
