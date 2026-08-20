"""Data-lake provenance is part of point-in-time correctness."""

from __future__ import annotations

import json
from pathlib import Path

from model.ingest.nflverse import DATASETS, TRAIN_TIME_ONLY, _write_manifest


def test_manifest_marks_live_charting_and_postseason_participation_correctly(tmp_path: Path) -> None:
    _write_manifest(
        tmp_path,
        DATASETS,
        [{"dataset": "pbp", "season": 2025, "path": "pbp/2025.parquet", "rows": 123, "bytes": 456}],
    )

    manifest = json.loads((tmp_path / "manifest.json").read_text())
    by_name = {dataset["name"]: dataset for dataset in manifest["datasets"]}

    assert by_name["ftn_charting"]["serveTimeEligible"] is True
    assert by_name["pbp_participation"]["serveTimeEligible"] is False
    assert "pbp_participation" in TRAIN_TIME_ONLY
    assert "ftn_charting" not in TRAIN_TIME_ONLY
    assert manifest["assets"] == [
        {"dataset": "pbp", "season": 2025, "path": "pbp/2025.parquet", "rows": 123, "bytes": 456}
    ]
