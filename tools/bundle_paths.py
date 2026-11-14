from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parents[1]
CLIENT_ROOT = BUNDLE_ROOT / "sources" / "Honeymoon"

def report_path(name):
    folder = BUNDLE_ROOT / "analysis" / "rerun"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / name
