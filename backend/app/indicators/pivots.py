"""Confirmed local extrema shared by chart levels and Dow structure."""
import math


def pivot_candidate(values, index, direction, left=3, right=2):
    if index < left or index + right >= len(values):
        return False
    window = values[index-left:index+right+1]
    if any(v is None or not math.isfinite(v) for v in window):
        return False
    value = direction * values[index]
    return (all(value >= direction*v for v in values[index-left:index])
            and all(value > direction*v for v in values[index+1:index+right+1]))
