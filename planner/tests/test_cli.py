import json
from pathlib import Path
import subprocess
import sys

from vmax_planner.cli import project_batches
from vmax_planner.demo import demo_job

RUNNER = Path(__file__).resolve().parents[1] / "run.py"


def invoke(*args, data=None):
    return subprocess.run([sys.executable, str(RUNNER), *args], input=data, capture_output=True, text=True,
                          encoding="utf-8", timeout=20)


def test_demo_runs_real_solver_and_labels_synthetic_sources():
    process = invoke("--demo")
    assert process.returncode == 0, process.stderr
    result = json.loads(process.stdout)
    assert result["status"] == "AVAILABLE" and result["data_mode"] == "test"
    assert [v["place_id"] for v in result["days"][0]["visits"]] == ["museum-near", "cafe"]
    assert result["total_budget_upper_minor"] == 100000
    assert result["days"][0]["ends_at"] == 1095  # 18:15, no automatic return to start.


def test_json_stdin_protocol_and_demo_input_roundtrip():
    exported = invoke("--demo-input")
    assert json.loads(exported.stdout) == demo_job()
    result = invoke(data=exported.stdout)
    assert result.returncode == 0
    assert json.loads(result.stdout)["status"] == "AVAILABLE"


def test_error_never_echoes_input():
    result = invoke(data='{"secret":"never-echo-me"}')
    assert result.returncode == 2
    assert json.loads(result.stdout)["issues"] == ["INVALID_PLANNING_INPUT"]
    assert "never-echo-me" not in result.stdout + result.stderr


def test_provider_batch_projection_can_feed_solver_without_disk_persistence():
    job = demo_job()
    job.pop("places")
    job["intent"]["shared"].pop("budget")
    source = job["route_legs"][0]["source"]
    job["provider_batches"] = [{"region_id": "32", "fetched_at": source["fetched_at"],
        "valid_until": source["valid_until"], "data_mode": "test", "items": [
            {"id": "museum-near", "name": "Учебный музей", "rubrics": [{"id": "museum"}],
             "point": {"lat": 55.751, "lon": 37.622}, "schedule": {"is_24x7": True}},
            {"id": "cafe", "name": "Учебное кафе", "rubrics": [{"id": "cafe"}],
             "point": {"lat": 55.752, "lon": 37.624}, "schedule": {"is_24x7": True}}]}]
    assert len(project_batches(job)["places"]) == 2
    result = invoke(data=json.dumps(job))
    assert result.returncode == 0
    output = json.loads(result.stdout)
    assert output["status"] == "AVAILABLE"
    assert output["total_expected_cost_minor"] is None
