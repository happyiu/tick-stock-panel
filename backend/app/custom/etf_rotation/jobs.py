# ruff: noqa: RUF001
"""Single rotation queue; backtests run in spawned processes, independently of core workers."""

import multiprocessing as mp
import queue
import threading
import uuid
from contextlib import suppress
from datetime import UTC, datetime

from .data import check_snapshot, load_snapshot, prepare, snapshot_digest
from .engine import simulate
from .models import SOURCE_REVISION, VERSION, RunRequest
from .storage import Store


def now():
    return datetime.now(UTC).isoformat()


def _worker(root, identifier, events):
    store = Store(root)
    try:
        payload = store.read("inputs", identifier)
        request = RunRequest.model_validate(payload["request"])
        result = simulate(
            request.config,
            payload["snapshot"],
            request.start.isoformat(),
            request.end.isoformat(),
            request.initial_cash,
            progress=lambda pct: events.put(pct),
        )
        if request.config.strategy == "composite_momentum_enhanced":
            baseline_config = request.config.model_copy(deep=True)
            baseline_config.strategy = "composite_momentum"
            baseline = simulate(
                baseline_config,
                payload["snapshot"],
                request.start.isoformat(),
                request.end.isoformat(),
                request.initial_cash,
                progress=lambda pct: events.put(95),
            )
            result["comparison"] = {
                "label": "基础复合动量（相同行情、区间、费用及风控）",
                "stats": baseline["stats"],
                "daily": baseline["daily"],
            }
        result["metadata"] = {
            k: payload[k]
            for k in ["request", "data_digest", "source_revision", "algorithm_version"]
        }
        store.write("results", identifier, result)
        events.put("done")
    except Exception as exc:
        events.put({"error": str(exc)})


class Jobs:
    def __init__(self, data_dir):
        self.store = Store(data_dir)
        self.owner = (self.store.root / ".queue.lock").open("a+b")
        try:
            import os

            if os.name == "nt":
                import msvcrt

                self.owner.seek(0)
                self.owner.write(b"0")
                self.owner.flush()
                self.owner.seek(0)
                msvcrt.locking(self.owner.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.owner.close()
            raise OSError("ETF轮动队列已经由另一个后端进程管理，请使用单进程后端") from None
        self.data_dir = str(data_dir)
        self.queue = queue.Queue()
        self.stop = threading.Event()
        self.canceled = set()
        with self.store.lock:
            for job in self.store.list("jobs"):
                if job["status"] in {"queued", "running"}:
                    job.update(status="interrupted", error="服务重启，任务已中断", updated_at=now())
                    self.store.write("jobs", job["id"], job)
        self.thread = threading.Thread(target=self._loop, daemon=True, name="etf-rotation-queue")
        self.thread.start()

    def submit(self, kind, request, repo, capabilities):
        with self.store.lock:
            if sum(j["status"] in {"queued", "running"} for j in self.store.list("jobs")) >= 20:
                raise ValueError("队列已满，请等待任务完成")
            identifier = uuid.uuid4().hex
            job = {
                "id": identifier,
                "kind": kind,
                "name": request.config.name,
                "status": "queued",
                "progress": 0,
                "created_at": now(),
                "updated_at": now(),
                "error": None,
            }
            self.store.write("jobs", identifier, job)
            self.queue.put((identifier, kind, request.model_copy(deep=True), repo, capabilities))
            return job

    def update(self, identifier, **fields):
        with self.store.lock:
            job = self.store.read("jobs", identifier)
            if job["status"] in {"canceled", "interrupted"} and fields.get("status") not in {
                "canceled",
                "interrupted",
            }:
                return job
            job.update(**fields, updated_at=now())
            self.store.write("jobs", identifier, job)
            return job

    def cancel(self, identifier):
        with self.store.lock:
            job = self.store.read("jobs", identifier)
            if job["status"] in {"queued", "running"}:
                self.canceled.add(identifier)
                return self.update(identifier, status="canceled")
            return job

    def _progress(self, identifier, pct):
        if identifier in self.canceled or self.stop.is_set():
            raise InterruptedError("任务已取消")
        self.update(identifier, progress=pct)

    def _loop(self):
        while not self.stop.is_set():
            try:
                identifier, kind, request, repo, caps = self.queue.get(timeout=0.2)
            except queue.Empty:
                continue
            process = None
            events = None
            try:
                self._progress(identifier, 1)
                self.update(identifier, status="running")
                if kind == "prepare":
                    check = prepare(
                        repo,
                        caps,
                        request,
                        lambda p, identifier=identifier: self._progress(identifier, p),
                    )
                    self._progress(identifier, 100)
                    self.update(identifier, status="completed", data_check=check)
                    continue
                snapshot = load_snapshot(repo, request)
                check = check_snapshot(
                    request.config, snapshot, request.start.isoformat(), request.end.isoformat()
                )
                if not check["ready"]:
                    raise ValueError(
                        check["reason"] + "；共同起点: " + str(check["proposed_start"])
                    )
                payload = {
                    "request": request.model_dump(mode="json"),
                    "snapshot": snapshot,
                    "data_digest": snapshot_digest(snapshot),
                    "source_revision": SOURCE_REVISION,
                    "algorithm_version": VERSION,
                }
                self.store.write("inputs", identifier, payload)
                self._progress(identifier, 5)
                context = mp.get_context("spawn")
                events = context.Queue()
                process = context.Process(
                    target=_worker, args=(self.data_dir, identifier, events), daemon=True
                )
                process.start()
                done = False
                while True:
                    self._progress(identifier, self.store.read("jobs", identifier)["progress"])
                    try:
                        event = events.get(timeout=0.2)
                    except queue.Empty:
                        if not process.is_alive():
                            raise RuntimeError("回测子进程意外退出") from None
                        continue
                    if event == "done":
                        done = True
                        break
                    if isinstance(event, dict):
                        raise RuntimeError(event["error"])
                    self._progress(identifier, event)
                process.join(timeout=5)
                if done:
                    self._progress(identifier, 100)
                    self.update(identifier, status="completed")
            except InterruptedError:
                self.update(
                    identifier, status="canceled" if identifier in self.canceled else "interrupted"
                )
            except Exception as exc:
                self.update(identifier, status="failed", error=str(exc))
            finally:
                if process is not None and process.is_alive():
                    process.terminate()
                    process.join(timeout=5)
                if events is not None:
                    events.close()
                self.queue.task_done()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=6)
        with self.store.lock:
            for job in self.store.list("jobs"):
                if job["status"] in {"queued", "running"}:
                    self.update(job["id"], status="interrupted", error="服务关闭，任务已中断")

        if not self.thread.is_alive():
            self.owner.close()


_managers = {}
_lock = threading.Lock()


def manager(data_dir):
    key = str(data_dir)
    with _lock:
        if key not in _managers:
            _managers[key] = Jobs(data_dir)
        return _managers[key]


def close_all():
    with _lock:
        for item in _managers.values():
            with suppress(Exception):
                item.close()
        _managers.clear()
