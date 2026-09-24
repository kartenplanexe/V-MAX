"""Bounded JSON stdin/file -> JSON stdout protocol. No HTTP or persistence."""
import argparse
from decimal import InvalidOperation
import json
from pathlib import Path
import sys

from .demo import demo_job
from .dgis import normalize_place
from .selection import select_places
from .routing import prepare_routes, route_checks

MAX_BYTES = 8 * 1024 * 1024


def project_batches(job):
    """Optionally convert internal BFF batches to the solver's canonical places."""
    if "provider_batches" not in job: return job
    if "places" in job: raise ValueError("provide places OR provider_batches")
    batches = job["provider_batches"]
    if not isinstance(batches, list) or len(batches) > 30: raise ValueError("invalid batches")
    dates = [d["date"] for d in job["intent"]["days"]]
    places = {}
    for batch in batches:
        if batch["region_id"] != job["intent"]["locality"]["region_id"]: raise ValueError("region mismatch")
        for item in batch["items"]:
            if item["id"] in places: continue
            if len(places) >= 2000: raise ValueError("candidate pool too large")
            places[item["id"]] = normalize_place(item, dates=dates, requested_region_id=batch["region_id"],
                fetched_at=batch["fetched_at"], valid_until=batch["valid_until"], data_mode=batch["data_mode"])
    return {k: v for k, v in job.items() if k != "provider_batches"} | {"places": list(places.values())}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Подбор мест: JSON → OR-Tools → проверенный план. Без API и LLM.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--input", help="JSON-файл; без аргумента читаем stdin")
    group.add_argument("--demo", action="store_true", help="синтетический пример без сети и ключей")
    group.add_argument("--demo-input", action="store_true", help="показать полный вход синтетического примера")
    parser.add_argument("--time-limit", type=float, default=3.0)
    parser.add_argument("--operation", choices=("solve", "prepare-routes", "route-checks"), default="solve")
    args = parser.parse_args(argv)
    try:
        if args.demo or args.demo_input:
            job = demo_job()
        else:
            if args.input:
                with Path(args.input).open("rb") as stream: raw = stream.read(MAX_BYTES + 1)
            else:
                raw = sys.stdin.buffer.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES: raise ValueError("input too large")
            job = json.loads(raw.decode("utf-8-sig"))
        if args.demo_input: result = job
        elif args.operation == "prepare-routes": result = prepare_routes(project_batches(job))
        elif args.operation == "route-checks": result = route_checks(job)
        else: result = select_places(project_batches(job), time_limit_seconds=args.time_limit)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0 if args.demo_input or result["status"] != "ERROR" else 3
    except (ValueError, KeyError, TypeError, AttributeError, InvalidOperation, OSError, RecursionError):
        # Never echo a raw provider value, local path, secret, or input text.
        print(json.dumps({"schema_version": "place-selection.v1", "status": "ERROR", "issues": ["INVALID_PLANNING_INPUT"]}))
        return 2
