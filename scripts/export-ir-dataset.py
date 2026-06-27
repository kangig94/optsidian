#!/usr/bin/env python3
"""Export a deterministic qrels subset from an ir_datasets dataset as JSON."""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import ir_datasets

CORPUS_MODES = ("judged", "sample", "smoke", "full")
QUERY_SAMPLE_MODES = ("even", "random", "stratified")
DOCUMENT_SAMPLE_MODES = ("random", "stratified")


def main() -> int:
    args = parse_args()
    dataset = ir_datasets.load(args.dataset)
    output = Path(args.output)
    documents_output = Path(args.documents_output or output.with_suffix(".documents.jsonl"))
    qrels_by_query = load_qrels(dataset, args.min_relevance)
    query_by_id = load_queries(dataset, sorted(qrels_by_query.keys(), key=natural_key))
    query_ids, query_sampling = select_query_ids(
        qrels_by_query,
        args.max_queries,
        args.query_sample,
        args.query_seed,
        query_by_id,
    )
    selected_queries = []
    positive_doc_ids = set()
    judged_negative_doc_ids = set()

    for query_id in query_ids:
        qrels = select_qrels(qrels_by_query[query_id], args.max_qrels_per_query, args.max_negative_qrels_per_query)
        for qrel in qrels:
            if qrel["relevance"] > 0:
                positive_doc_ids.add(qrel["doc_id"])
            else:
                judged_negative_doc_ids.add(qrel["doc_id"])
        selected_queries.append(
            {
                "queryId": query_id,
                "text": query_text(query_by_id.get(query_id, {})),
                "fields": query_by_id.get(query_id, {}),
                "qrels": qrels,
            }
        )

    documents_count, missing_doc_ids, document_sampling = export_documents(
        dataset,
        positive_doc_ids,
        judged_negative_doc_ids,
        documents_output,
        args.corpus_mode,
        args.max_background_docs,
        args.sample_size,
        args.sample_seed,
        args.document_sample,
    )
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
            "maxNegativeQrelsPerQuery": args.max_negative_qrels_per_query,
            "minRelevance": args.min_relevance,
            "maxBackgroundDocs": args.max_background_docs,
            "corpusMode": args.corpus_mode,
            "sampleSize": args.sample_size,
            "sampleSeed": args.sample_seed,
            "querySample": args.query_sample,
            "querySeed": args.query_seed,
            "documentSample": args.document_sample,
        },
        "queries": selected_queries,
        "documentsFile": str(documents_output),
        "documentsCount": documents_count,
        "missingDocIds": missing_doc_ids,
        "sampling": {
            "query": query_sampling,
            "documents": document_sampling,
        },
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json_text(payload, indent=2) + "\n", encoding="utf-8")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True, help="ir_datasets dataset id, e.g. beir/nfcorpus/test")
    parser.add_argument("--output", required=True, help="JSON output path")
    parser.add_argument("--documents-output", help="JSONL document output path")
    parser.add_argument("--max-queries", type=int, default=50, help="0 means all positive-query ids")
    parser.add_argument("--query-sample", choices=QUERY_SAMPLE_MODES, default="even")
    parser.add_argument("--query-seed", type=int, default=0)
    parser.add_argument("--max-qrels-per-query", type=int, default=0, help="0 means all qrels for selected queries")
    parser.add_argument("--max-negative-qrels-per-query", type=int, default=0, help="extra non-positive judged qrels to keep per selected query")
    parser.add_argument("--min-relevance", type=float, default=1.0, help="minimum positive qrel grade")
    parser.add_argument("--max-background-docs", type=int, default=0, help="extra corpus docs with no qrels")
    parser.add_argument(
        "--corpus-mode",
        choices=CORPUS_MODES,
        default="judged",
        help="judged writes selected qrel docs, smoke fills to --sample-size with seeded random background, sample adds background docs, full writes the entire corpus",
    )
    parser.add_argument("--sample-size", type=int, default=100, help="target document count for --corpus-mode=smoke")
    parser.add_argument("--sample-seed", type=int, default=0, help="random seed for --corpus-mode=smoke background documents")
    parser.add_argument("--document-sample", choices=DOCUMENT_SAMPLE_MODES, default="random")
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


def select_query_ids(
    qrels_by_query: dict[str, list[dict]],
    max_queries: int,
    sample_mode: str,
    seed: int,
    query_by_id: dict[str, dict],
) -> tuple[list[str], dict]:
    query_ids = sorted(qrels_by_query.keys(), key=natural_key)
    if max_queries <= 0 or max_queries >= len(query_ids):
        return query_ids, query_sampling_report(sample_mode, seed, query_ids, query_ids, qrels_by_query, query_by_id)
    if sample_mode == "random":
        rng = random.Random(seed)
        selected = sorted(rng.sample(query_ids, max_queries), key=natural_key)
    elif sample_mode == "stratified":
        selected = stratified_query_sample(query_ids, qrels_by_query, query_by_id, max_queries, seed)
    else:
        selected = sample_even(query_ids, max_queries)
    return selected, query_sampling_report(sample_mode, seed, query_ids, selected, qrels_by_query, query_by_id)


def select_qrels(qrels: list[dict], max_qrels_per_query: int, max_negative_qrels_per_query: int) -> list[dict]:
    if max_qrels_per_query <= 0 and max_negative_qrels_per_query <= 0:
        return qrels
    positives = [qrel for qrel in qrels if qrel["relevance"] > 0]
    nonpositives = [qrel for qrel in qrels if qrel["relevance"] <= 0]
    selected = positives if max_qrels_per_query <= 0 else positives[:max_qrels_per_query]
    if max_negative_qrels_per_query > 0:
        selected.extend(nonpositives[:max_negative_qrels_per_query])
    elif max_qrels_per_query > 0 and len(selected) < max_qrels_per_query:
        selected.extend(nonpositives[: max_qrels_per_query - len(selected)])
    return selected


def stratified_query_sample(
    query_ids: list[str],
    qrels_by_query: dict[str, list[dict]],
    query_by_id: dict[str, dict],
    count: int,
    seed: int,
) -> list[str]:
    buckets: dict[str, list[str]] = {}
    for query_id in query_ids:
        bucket = query_bucket(query_id, qrels_by_query[query_id], query_by_id.get(query_id, {}))
        buckets.setdefault(bucket, []).append(query_id)
    allocations = proportional_allocations({bucket: len(ids) for bucket, ids in buckets.items()}, count)
    rng = random.Random(seed)
    selected = []
    for bucket in sorted(buckets.keys(), key=natural_key):
        ids = sorted(buckets[bucket], key=natural_key)
        target = allocations.get(bucket, 0)
        if target <= 0:
            continue
        if target >= len(ids):
            selected.extend(ids)
        else:
            selected.extend(rng.sample(ids, target))
    return sorted(selected, key=natural_key)


def query_sampling_report(
    sample_mode: str,
    seed: int,
    candidate_ids: list[str],
    selected_ids: list[str],
    qrels_by_query: dict[str, list[dict]],
    query_by_id: dict[str, dict],
) -> dict:
    candidate_buckets: dict[str, int] = {}
    selected_buckets: dict[str, int] = {}
    selected = set(selected_ids)
    for query_id in candidate_ids:
        bucket = query_bucket(query_id, qrels_by_query[query_id], query_by_id.get(query_id, {}))
        candidate_buckets[bucket] = candidate_buckets.get(bucket, 0) + 1
        if query_id in selected:
            selected_buckets[bucket] = selected_buckets.get(bucket, 0) + 1
    return {
        "mode": sample_mode,
        "seed": seed,
        "candidates": len(candidate_ids),
        "selected": len(selected_ids),
        "candidateBuckets": sorted_count_record(candidate_buckets),
        "selectedBuckets": sorted_count_record(selected_buckets),
    }


def query_bucket(query_id: str, qrels: list[dict], fields: dict) -> str:
    text = query_text(fields)
    return "|".join(
        [
            script_bucket(text),
            query_length_bucket(text),
            qrel_count_bucket(qrels),
            relevance_shape_bucket(qrels),
        ]
    )


def script_bucket(text: str) -> str:
    hangul = len(re.findall(r"[\uac00-\ud7a3]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    digits = len(re.findall(r"\d", text))
    if hangul > 0 and latin > 0:
        return "script:mixed"
    if hangul > 0:
        return "script:hangul"
    if latin > 0 and digits > 0:
        return "script:latin-numeric"
    if latin > 0:
        return "script:latin"
    if digits > 0:
        return "script:numeric"
    return "script:other"


def query_length_bucket(text: str) -> str:
    tokens = re.findall(r"[\w\uac00-\ud7a3]+", text, flags=re.UNICODE)
    token_count = len(tokens)
    char_count = len(text.strip())
    if token_count <= 3 and char_count <= 24:
        return "len:short"
    if token_count <= 8 and char_count <= 96:
        return "len:medium"
    return "len:long"


def qrel_count_bucket(qrels: list[dict]) -> str:
    count = len(qrels)
    if count <= 1:
        return "qrels:sparse"
    if count <= 10:
        return "qrels:normal"
    return "qrels:dense"


def relevance_shape_bucket(qrels: list[dict]) -> str:
    positive_scores = {qrel["relevance"] for qrel in qrels if qrel["relevance"] > 0}
    has_negative = any(qrel["relevance"] <= 0 for qrel in qrels)
    graded = len(positive_scores) > 1 or any(score > 1 for score in positive_scores)
    if graded and has_negative:
        return "rel:graded-with-neg"
    if graded:
        return "rel:graded"
    if has_negative:
        return "rel:binary-with-neg"
    return "rel:binary"


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


def export_documents(
    dataset,
    positive_doc_ids: set[str],
    judged_negative_doc_ids: set[str],
    output_path: Path,
    corpus_mode: str,
    max_background_docs: int,
    sample_size: int,
    sample_seed: int,
    document_sample: str,
) -> tuple[int, list[str], dict]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    required_doc_ids = set(positive_doc_ids) | set(judged_negative_doc_ids)
    if corpus_mode == "full":
        return export_full_documents(dataset, required_doc_ids, output_path, positive_doc_ids, judged_negative_doc_ids, document_sample, sample_seed)
    if corpus_mode == "smoke":
        return export_smoke_documents(
            dataset,
            required_doc_ids,
            positive_doc_ids,
            judged_negative_doc_ids,
            output_path,
            sample_size,
            sample_seed,
            document_sample,
        )

    background_count = max_background_docs if corpus_mode == "sample" else 0
    documents, missing_doc_ids = load_selected_documents(dataset, required_doc_ids, background_count)
    with output_path.open("w", encoding="utf-8") as output:
        for document in documents:
            output.write(json_text(document) + "\n")
    report = document_sampling_report(
        corpus_mode=corpus_mode,
        sample_mode="first",
        seed=sample_seed,
        sample_size=sample_size,
        positive_doc_ids=positive_doc_ids,
        judged_negative_doc_ids=judged_negative_doc_ids,
        output_documents=len(documents),
        documents=documents,
        background_count=max(0, len(documents) - len(required_doc_ids)),
        strata_counts={},
        selected_strata_counts=strata_counts(documents),
    )
    return len(documents), missing_doc_ids, report


def export_full_documents(
    dataset,
    required_doc_ids: set[str],
    output_path: Path,
    positive_doc_ids: set[str],
    judged_negative_doc_ids: set[str],
    document_sample: str,
    sample_seed: int,
) -> tuple[int, list[str], dict]:
    missing = set(required_doc_ids)
    count = 0
    selected_strata: dict[str, int] = {}
    with output_path.open("w", encoding="utf-8") as output:
        for doc in dataset.docs_iter():
            row = row_dict(doc)
            doc_id = str(row.get("doc_id", ""))
            if not doc_id:
                continue
            missing.discard(doc_id)
            output.write(json_text({"docId": doc_id, "fields": row}) + "\n")
            stratum = document_stratum(row)
            selected_strata[stratum] = selected_strata.get(stratum, 0) + 1
            count += 1
    report = document_sampling_report(
        corpus_mode="full",
        sample_mode=document_sample,
        seed=sample_seed,
        sample_size=count,
        positive_doc_ids=positive_doc_ids,
        judged_negative_doc_ids=judged_negative_doc_ids,
        output_documents=count,
        documents=[],
        background_count=max(0, count - len(required_doc_ids)),
        strata_counts=selected_strata,
        selected_strata_counts=selected_strata,
    )
    return count, sorted(missing, key=natural_key), report


def export_smoke_documents(
    dataset,
    required_doc_ids: set[str],
    positive_doc_ids: set[str],
    judged_negative_doc_ids: set[str],
    output_path: Path,
    sample_size: int,
    sample_seed: int,
    document_sample: str,
) -> tuple[int, list[str], dict]:
    if sample_size < 1:
        raise ValueError("--sample-size must be at least 1")

    required_documents, missing_doc_ids = load_selected_documents(dataset, required_doc_ids, 0)
    required_count = len(required_documents)
    background_target = max(0, sample_size - required_count)
    strata_available = {}
    target_final_strata = {}
    if document_sample == "stratified":
        background_documents, strata_available, target_final_strata = sample_background_documents_stratified(
            dataset,
            required_doc_ids,
            required_documents,
            sample_size,
            background_target,
            sample_seed,
        )
    else:
        background_documents = sample_background_documents(dataset, required_doc_ids, background_target, sample_seed)
    documents = sorted(required_documents + background_documents, key=lambda item: natural_key(item["docId"]))

    with output_path.open("w", encoding="utf-8") as output:
        for document in documents:
            output.write(json_text(document) + "\n")
    report = document_sampling_report(
        corpus_mode="smoke",
        sample_mode=document_sample,
        seed=sample_seed,
        sample_size=sample_size,
        positive_doc_ids=positive_doc_ids,
        judged_negative_doc_ids=judged_negative_doc_ids,
        output_documents=len(documents),
        documents=documents,
        background_count=len(background_documents),
        strata_counts=strata_available,
        required_strata_counts=strata_counts(required_documents),
        target_final_strata_counts=target_final_strata,
        selected_strata_counts=strata_counts(background_documents),
    )
    return len(documents), missing_doc_ids, report


def sample_background_documents(dataset, required_doc_ids: set[str], count: int, seed: int) -> list[dict]:
    if count <= 0:
        return []

    rng = random.Random(seed)
    reservoir = []
    seen = 0
    for doc in dataset.docs_iter():
        row = row_dict(doc)
        doc_id = str(row.get("doc_id", ""))
        if not doc_id or doc_id in required_doc_ids:
            continue
        seen += 1
        document = {"docId": doc_id, "fields": row}
        if len(reservoir) < count:
            reservoir.append(document)
            continue
        replace_at = rng.randrange(seen)
        if replace_at < count:
            reservoir[replace_at] = document

    return reservoir


def sample_background_documents_stratified(
    dataset,
    required_doc_ids: set[str],
    required_documents: list[dict],
    sample_size: int,
    count: int,
    seed: int,
) -> tuple[list[dict], dict[str, int], dict[str, int]]:
    if count <= 0:
        return [], {}, {}

    available_counts = count_background_strata(dataset, required_doc_ids)
    required_counts = strata_counts(required_documents)
    allocations, target_final_counts = compensated_background_allocations(available_counts, required_counts, sample_size, count)
    reservoirs: dict[str, list[dict]] = {stratum: [] for stratum, target in allocations.items() if target > 0}
    seen_by_stratum: dict[str, int] = {}
    rng_by_stratum = {stratum: random.Random(stable_seed(seed, stratum)) for stratum in reservoirs}

    for doc in dataset.docs_iter():
        row = row_dict(doc)
        doc_id = str(row.get("doc_id", ""))
        if not doc_id or doc_id in required_doc_ids:
            continue
        stratum = document_stratum(row)
        target = allocations.get(stratum, 0)
        if target <= 0:
            continue
        seen = seen_by_stratum.get(stratum, 0) + 1
        seen_by_stratum[stratum] = seen
        document = {"docId": doc_id, "fields": row}
        reservoir = reservoirs[stratum]
        if len(reservoir) < target:
            reservoir.append(document)
            continue
        replace_at = rng_by_stratum[stratum].randrange(seen)
        if replace_at < target:
            reservoir[replace_at] = document

    documents = []
    for stratum in sorted(reservoirs.keys(), key=natural_key):
        documents.extend(reservoirs[stratum])
    return sorted(documents, key=lambda item: natural_key(item["docId"])), available_counts, target_final_counts


def count_background_strata(dataset, required_doc_ids: set[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for doc in dataset.docs_iter():
        row = row_dict(doc)
        doc_id = str(row.get("doc_id", ""))
        if not doc_id or doc_id in required_doc_ids:
            continue
        stratum = document_stratum(row)
        counts[stratum] = counts.get(stratum, 0) + 1
    return counts


def document_stratum(fields: dict) -> str:
    for key in ("source", "category", "section", "journal", "venue", "collection", "domain", "source_type", "type"):
        text = scalar_text(fields.get(key))
        if text:
            return f"{key}:{safe_bucket(text)}"

    url = scalar_text(fields.get("url"))
    if url:
        parsed = urlparse(url)
        if parsed.netloc:
            first_path = next((part for part in parsed.path.split("/") if part), "")
            return f"url:{safe_bucket(parsed.netloc)}{('/' + safe_bucket(first_path)) if first_path else ''}"

    doc_id = scalar_text(fields.get("doc_id"))
    numeric_bucket = doc_id_numeric_bucket(doc_id)
    if numeric_bucket:
        return f"doc_id_num:{numeric_bucket}"
    prefix = doc_id_prefix(doc_id)
    if prefix:
        return f"doc_id:{prefix}"
    return "all"


def scalar_text(value) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    return ""


def safe_bucket(value: str, limit: int = 48) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip().lower())
    normalized = re.sub(r"_+", "_", normalized).strip("_.-")
    return (normalized or "unknown")[:limit]


def doc_id_prefix(doc_id: str) -> str:
    if not doc_id:
        return ""
    match = re.match(r"^([A-Za-z]+)[A-Za-z_-]*[\d:/._-]", doc_id)
    if match:
        return safe_bucket(match.group(1), 24)
    match = re.match(r"^([^:/._-]+)", doc_id)
    if match:
        prefix = match.group(1)
        if len(prefix) < len(doc_id):
            return safe_bucket(prefix, 24)
    if len(doc_id) >= 2:
        return safe_bucket(doc_id[:2], 24)
    return safe_bucket(doc_id, 24)


def doc_id_numeric_bucket(doc_id: str) -> str:
    match = re.match(r"^(\d+)(?:\D|$)", doc_id)
    if not match:
        return ""
    number = int(match.group(1))
    width = 50_000
    start = (number // width) * width
    end = start + width - 1
    return f"{start:08d}-{end:08d}"


def strata_counts(documents: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for document in documents:
        stratum = document_stratum(document.get("fields", {}))
        counts[stratum] = counts.get(stratum, 0) + 1
    return counts


def document_sampling_report(
    *,
    corpus_mode: str,
    sample_mode: str,
    seed: int,
    sample_size: int,
    positive_doc_ids: set[str],
    judged_negative_doc_ids: set[str],
    output_documents: int,
    documents: list[dict],
    background_count: int,
    strata_counts: dict[str, int],
    required_strata_counts: dict[str, int] | None = None,
    target_final_strata_counts: dict[str, int] | None = None,
    selected_strata_counts: dict[str, int],
) -> dict:
    required_count = len(set(positive_doc_ids) | set(judged_negative_doc_ids))
    return {
        "corpusMode": corpus_mode,
        "mode": sample_mode,
        "seed": seed,
        "sampleSize": sample_size,
        "requiredPositiveDocs": len(positive_doc_ids),
        "requiredJudgedNegativeDocs": len(judged_negative_doc_ids),
        "requiredDocs": required_count,
        "documents": output_documents,
        "backgroundDocs": background_count,
        "availableStrata": sorted_count_record(strata_counts),
        "requiredStrata": sorted_count_record(required_strata_counts or {}),
        "targetFinalStrata": sorted_count_record(target_final_strata_counts or {}),
        "selectedBackgroundStrata": sorted_count_record(selected_strata_counts),
    }


def proportional_allocations(counts: dict[str, int], total: int) -> dict[str, int]:
    positive = {key: count for key, count in counts.items() if count > 0}
    if total <= 0 or not positive:
        return {}
    if len(positive) > total:
        selected_keys = sorted(positive.keys(), key=lambda key: (-positive[key], natural_key(key)))[:total]
        return {key: 1 for key in selected_keys}

    total_available = sum(positive.values())
    allocations = {}
    remaining = total
    for key in sorted(positive.keys(), key=natural_key):
        base = math.floor((positive[key] / total_available) * total)
        if total >= len(positive):
            base = max(1, base)
        base = min(base, positive[key])
        allocations[key] = base
        remaining -= base

    ranked = sorted(
        positive.keys(),
        key=lambda key: (
            -(((positive[key] / total_available) * total) - math.floor((positive[key] / total_available) * total)),
            -positive[key],
            natural_key(key),
        ),
    )
    while remaining > 0:
        changed = False
        for key in ranked:
            if allocations[key] >= positive[key]:
                continue
            allocations[key] += 1
            remaining -= 1
            changed = True
            if remaining == 0:
                break
        if not changed:
            break

    while remaining < 0:
        changed = False
        for key in reversed(ranked):
            minimum = 1 if total >= len(positive) else 0
            if allocations[key] <= minimum:
                continue
            allocations[key] -= 1
            remaining += 1
            changed = True
            if remaining == 0:
                break
        if not changed:
            break
    return {key: value for key, value in allocations.items() if value > 0}


def compensated_background_allocations(
    available_counts: dict[str, int],
    required_counts: dict[str, int],
    sample_size: int,
    background_target: int,
) -> tuple[dict[str, int], dict[str, int]]:
    full_counts = {
        key: available_counts.get(key, 0) + required_counts.get(key, 0)
        for key in set(available_counts) | set(required_counts)
    }
    full_total = sum(full_counts.values())
    target_total = min(sample_size, full_total)
    target_final = proportional_allocations(full_counts, target_total)
    allocations: dict[str, int] = {}

    for key, target in target_final.items():
        required = required_counts.get(key, 0)
        available = available_counts.get(key, 0)
        allocations[key] = max(0, min(available, target - required))

    remaining = max(0, min(background_target, full_total - sum(required_counts.values())) - sum(allocations.values()))
    if remaining <= 0:
        return {key: value for key, value in allocations.items() if value > 0}, target_final

    while remaining > 0:
        candidates = [
            key for key, available in available_counts.items()
            if allocations.get(key, 0) < available
        ]
        if not candidates:
            break
        candidates.sort(key=lambda key: (
            sample_fraction(required_counts.get(key, 0) + allocations.get(key, 0), full_counts.get(key, 0)),
            -full_counts.get(key, 0),
            natural_key(key),
        ))
        changed = False
        for key in candidates:
            if allocations.get(key, 0) >= available_counts[key]:
                continue
            allocations[key] = allocations.get(key, 0) + 1
            remaining -= 1
            changed = True
            if remaining == 0:
                break
        if not changed:
            break

    return {key: value for key, value in allocations.items() if value > 0}, target_final


def sample_fraction(selected: int, full_count: int) -> float:
    if full_count <= 0:
        return float("inf")
    return selected / full_count


def sorted_count_record(counts: dict[str, int]) -> dict[str, int]:
    return {key: counts[key] for key in sorted(counts.keys(), key=natural_key)}


def stable_seed(seed: int, value: str) -> int:
    text = f"{seed}:{value}"
    acc = 0
    for char in text:
        acc = ((acc * 131) + ord(char)) % (2**32)
    return acc


def load_selected_documents(dataset, required_doc_ids: set[str], max_background_docs: int) -> tuple[list[dict], list[str]]:
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


def json_text(value, indent: int | None = None) -> str:
    text = json.dumps(value, ensure_ascii=False, indent=indent)
    return text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


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
