import base64
import json
import os
import re
import urllib.error
import urllib.request
from datetime import date

GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]
GITHUB_REPO = os.environ["GITHUB_REPO"]
FILE_PATH = os.environ.get("UPDATES_FILE_PATH", "data/updates.json")
BRANCH = os.environ.get("GITHUB_BRANCH", "main")

ALLOWED_DOC_TYPES = {"NPRM", "Final Rule", "Notice", "Proposed Priority", "Final Priority"}
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REQUIRED_FIELDS = [
    "id",
    "dateFound",
    "weekOf",
    "docNumber",
    "title",
    "agency",
    "documentType",
    "categoryType",
    "regulatoryStage",
    "commentDeadline",
    "effectiveDate",
    "k12Relevance",
    "summary",
    "context",
    "federalRegisterLink",
    "executiveSummaryBullets",
]


def make_id(entry):
    doc_number = entry.get("docNumber") or f"UNKNOWN-{entry.get('dateFound', 'NO-DATE')}"
    doc = re.sub(r"[^a-zA-Z0-9-]", "_", doc_number)
    return f"{entry['dateFound']}_{doc}"


def validate_entry(entry, existing_ids):
    errors = []
    for field in REQUIRED_FIELDS:
        value = entry.get(field)
        if value is None or value == "" or value == []:
            errors.append(f"Missing or empty field: {field}")

    if entry.get("documentType") not in ALLOWED_DOC_TYPES:
        errors.append(f"Invalid documentType: {entry.get('documentType')}")

    date_found = entry.get("dateFound", "")
    if not DATE_PATTERN.match(date_found):
        errors.append(f"Invalid date format in dateFound: {date_found}")

    for date_field in ["commentDeadline", "effectiveDate"]:
        value = entry.get(date_field, "")
        if value not in ("TBD", "N/A") and not DATE_PATTERN.match(value):
            errors.append(f"Invalid date format in {date_field}: {value}")

    if entry.get("id") in existing_ids:
        errors.append(f"Duplicate id: {entry.get('id')}")

    bullets = entry.get("executiveSummaryBullets")
    if not isinstance(bullets, list) or not bullets or not all(isinstance(item, str) and item for item in bullets):
        errors.append("executiveSummaryBullets must be a non-empty list of strings")

    return errors


def github_request(url, method="GET", payload=None):
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
    }
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read())


def get_current_json():
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{FILE_PATH}?ref={BRANCH}"
    try:
        data = github_request(url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return [], None
        raise

    content = base64.b64decode(data["content"]).decode("utf-8")
    return json.loads(content), data["sha"]


def commit_updated_json(updated_data, sha):
    content_bytes = json.dumps(updated_data, indent=2).encode("utf-8")
    payload = {
        "message": f"Daily update: {date.today().isoformat()}",
        "content": base64.b64encode(content_bytes).decode("utf-8"),
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha

    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{FILE_PATH}"
    return github_request(url, method="PUT", payload=payload)


def commit_new_entries(new_entries):
    current_data, sha = get_current_json()
    existing_ids = {entry["id"] for entry in current_data if "id" in entry}
    valid_entries = []

    for entry in new_entries:
        if not entry.get("id"):
            entry["id"] = make_id(entry)

        errors = validate_entry(entry, existing_ids)
        if errors:
            print(f"SKIPPING entry '{entry.get('title', 'unknown')}' due to validation errors: {errors}")
            continue

        valid_entries.append(entry)
        existing_ids.add(entry["id"])

    if not valid_entries:
        print("No valid new entries to commit today.")
        return None

    result = commit_updated_json(current_data + valid_entries, sha)
    print(f"Committed {len(valid_entries)} new entries to GitHub.")
    return result


if __name__ == "__main__":
    raise SystemExit(
        "Import commit_new_entries(new_entries) from the Cowork scheduled task after building the daily entries."
    )
