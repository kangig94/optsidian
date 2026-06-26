#!/usr/bin/env python3
"""Export a deterministic qrels subset from an ir_datasets dataset as JSON."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import ir_datasets


def main() -> int:
    args = parse_args()
    dataset = ir_datasets.load(args.dataset)
    qrels_by_query = load_qrels(dataset, args.min_relevance)
    query_ids = select_query_ids(qrels_by_query, args.max_queries)
    query_by_id = load_queries(dataset, query_ids)
    selected_queries = []
    required_doc_ids = set()

    for query_id in query_ids:
        qrels = select_qrels(qrels_by_query[query_id], args.max_qrels_per_query)
        for qrel in qrels:
            required_doc_ids.add(qrel["doc_id"])
        selected_queries.append(
            {
                "queryId": query_id,
                "text": query_text(query_by_id.get(query_id, {})),
                "fields": query_by_id.get(query_id, {}),
                "qrels": qrels,
            }
        )

    documents, missing_doc_ids = load_documents(dataset, required_doc_ids, args.max_background_docs)
    payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "irDatasetsVersion": getattr(ir_datasets, "__version__", "unknown"),
        "dataset": {
            "id": args.dataset,
            "docsCount": safe_count(dataset, "docs_count"),
            "queriesCount": safe_count(dataset, "queries_count"),
            "qrelsCount": safe_count(dataset, "qrels_count"),
        },
        "options": {
            "maxQueries": args.max_queries,
            "maxQrelsPerQuery": args.max_qrels_per_query,
            "minRelevance": args.min_relevance,
            "maxBackgroundDocs": args.max_background_docs,
        },
        "queries": selected_queries,
        "documents": documents,
        "missingDocIds": missing_doc_ids,
    }

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True, help="ir_datasets dataset id, e.g. beir/nfcorpus/test")
    parser.add_argument("--output", required=True, help="JSON output path")
    parser.add_argument("--max-queries", type=int, default=50, help="0 means all positive-query ids")
    parser.add_argument("--max-qrels-per-query", type=int, default=0, help="0 means all qrels for selected queries")
    parser.add_argument("--min-relevance", type=float, default=1.0, help="minimum positive qrel grade")
    parser.add_argument("--max-background-docs", type=int, default=0, help="extra corpus docs with no qrels")
    return parser.parse_args()


def load_qrels(dataset, min_relevance: float) -> dict[str, list[dict]]:
    qrels_by_query: dict[str, list[dict]] = {}
    positive_query_ids = set()
    for qrel in dataset.qrels_iter():
        row = row_dict(qrel)
        query_id = str(row.get("query_id", ""))
        doc_id = str(row.get("doc_id", ""))
        if not query_id or not doc_id:
            continue
        relevance = numeric(row.get("relevance", 0))
        qrels_by_query.setdefault(query_id, []).append(
            {
                "query_id": query_id,
                "doc_id": doc_id,
                "relevance": relevance,
            }
        )
        if relevance >= min_relevance:
            positive_query_ids.add(query_id)

    return {
        query_id: sorted(qrels, key=lambda item: (-item["relevance"], natural_key(item["doc_id"])))
        for query_id, qrels in qrels_by_query.items()
        if query_id in positive_query_ids
    }


def select_query_ids(qrels_by_query: dict[str, list[dict]], max_queries: int) -> list[str]:
    query_ids = sorted(qrels_by_query.keys(), key=natural_key)
    if max_queries <= 0 or max_queries >= len(query_ids):
        return query_ids
    return sample_even(query_ids, max_queries)


def select_qrels(qrels: list[dict], max_qrels_per_query: int) -> list[dict]:
    if max_qrels_per_query <= 0 or len(qrels) <= max_qrels_per_query:
        return qrels
    positives = [qrel for qrel in qrels if qrel["relevance"] > 0]
    nonpositives = [qrel for qrel in qrels if qrel["relevance"] <= 0]
    selected = positives[:max_qrels_per_query]
    if len(selected) < max_qrels_per_query:
        selected.extend(nonpositives[: max_qrels_per_query - len(selected)])
    return selected


def load_queries(dataset, query_ids: list[str]) -> dict[str, dict]:
    needed = set(query_ids)
    query_by_id = {}
    for query in dataset.queries_iter():
        row = row_dict(query)
        query_id = str(row.get("query_id", ""))
        if query_id in needed:
            query_by_id[query_id] = row
            if len(query_by_id) == len(needed):
                break
    return query_by_id


def load_documents(dataset, required_doc_ids: set[str], max_background_docs: int) -> tuple[list[dict], list[str]]:
    documents_by_id = {}
    missing = set(required_doc_ids)

    try:
        store = dataset.docs_store()
        for doc_id in sorted(required_doc_ids, key=natural_key):
            doc = store.get(doc_id)
            if doc is None:
                continue
            documents_by_id[doc_id] = row_dict(doc)
            missing.discard(doc_id)
        close = getattr(store, "close", None)
        if callable(close):
            close()
    except Exception as error:  # pragma: no cover - depends on dataset backend
        print(f"docs_store unavailable, falling back to docs_iter: {error}", file=sys.stderr)

    if missing or max_background_docs > 0:
        background_added = 0
        for doc in dataset.docs_iter():
            row = row_dict(doc)
            doc_id = str(row.get("doc_id", ""))
            if not doc_id:
                continue
            if doc_id in missing:
                documents_by_id[doc_id] = row
                missing.discard(doc_id)
            elif max_background_docs > 0 and doc_id not in required_doc_ids and doc_id not in documents_by_id:
                documents_by_id[doc_id] = row
                background_added += 1
                if background_added >= max_background_docs and not missing:
                    break
            if not missing and background_added >= max_background_docs:
                break

    documents = [
        {"docId": doc_id, "fields": documents_by_id[doc_id]}
        for doc_id in sorted(documents_by_id.keys(), key=natural_key)
    ]
    return documents, sorted(missing, key=natural_key)


def row_dict(row) -> dict:
    if hasattr(row, "_asdict"):
        source = row._asdict()
    elif hasattr(row, "__dict__"):
        source = row.__dict__
    else:
        return {}
    return {str(key): jsonable(value) for key, value in source.items()}


def jsonable(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    return str(value)


def query_text(fields: dict) -> str:
    for key in ("text", "query", "title", "description", "narrative"):
        value = fields.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def numeric(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if number.is_integer():
        return int(number)
    return number


def safe_count(dataset, method_name: str):
    method = getattr(dataset, method_name, None)
    if not callable(method):
        return None
    try:
        return method()
    except Exception:
        return None


def sample_even(items: list[str], count: int) -> list[str]:
    if count >= len(items):
        return list(items)
    if count == 1:
        return [items[0]]
    selected = []
    seen = set()
    for index in range(count):
        source_index = round(index * (len(items) - 1) / (count - 1))
        while source_index in seen and source_index < len(items) - 1:
            source_index += 1
        while source_index in seen and source_index > 0:
            source_index -= 1
        if source_index in seen:
            raise RuntimeError(f"duplicate sample index {source_index}")
        seen.add(source_index)
        selected.append(items[source_index])
    return selected


def natural_key(value) -> list:
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", str(value))]


if __name__ == "__main__":
    raise SystemExit(main())
