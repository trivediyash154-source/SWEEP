"""Independent Python oracle for the SWEEP engine.

It shares no code with the TypeScript engine. For every graph it computes the
optimal closed-route length two independent ways and compares with SWEEP:

1. networkx: sum(required) + min_weight_matching over odd vertices of the
   required subgraph, with Dijkstra shortest-path lengths in the full graph
   (Edmonds–Johnson). Used for all sizes.
2. brute force: minimum over all edge-duplication sets X (multiplicity 0/1)
   such that required + X is even and connected. Used for small graphs only.

It also re-validates every SWEEP route: consecutive, closed, covers every
required edge, and its length equals the reported total.

Run:  python3 -I oracle/run_oracle.py      (needs: pip install -r oracle/requirements.txt)
"""
from __future__ import annotations

import itertools
import json
import os
import random
import subprocess
import sys

import networkx as nx

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCALE = 1000


def random_graph(rng: random.Random, max_n: int, max_m: int, optional_prob: float) -> dict:
    n = rng.randint(2, max_n)
    m = rng.randint(1, max_m)
    vertices = [{"id": f"v{i}", "x": rng.randint(0, 500), "y": rng.randint(0, 500)} for i in range(n)]
    edges = []
    for k in range(m):
        u = rng.randrange(n)
        v = rng.randrange(n)
        if u == v and rng.random() < 0.7:
            v = (v + 1) % n
        w = rng.randint(0, 40) + (round(rng.random(), 3) if rng.random() < 0.3 else 0)
        edges.append({"id": f"e{k}", "u": f"v{u}", "v": f"v{v}", "weight": w, "required": rng.random() >= optional_prob})
    return {"vertices": vertices, "edges": edges}


def scaled(w: float) -> int:
    return round(w * SCALE)


def required_connected(g: dict) -> bool:
    req = [e for e in g["edges"] if e["required"]]
    if not req:
        return False
    h = nx.MultiGraph()
    for e in req:
        h.add_edge(e["u"], e["v"])
    return nx.is_connected(h)


def networkx_optimum(g: dict) -> int:
    full = nx.Graph()
    for v in g["vertices"]:
        full.add_node(v["id"])
    for e in g["edges"]:
        if e["u"] == e["v"]:
            continue
        w = scaled(e["weight"])
        if full.has_edge(e["u"], e["v"]):
            full[e["u"]][e["v"]]["weight"] = min(full[e["u"]][e["v"]]["weight"], w)
        else:
            full.add_edge(e["u"], e["v"], weight=w)
    deg: dict[str, int] = {}
    total = 0
    for e in g["edges"]:
        if not e["required"]:
            continue
        total += scaled(e["weight"])
        deg[e["u"]] = deg.get(e["u"], 0) + 1
        deg[e["v"]] = deg.get(e["v"], 0) + 1
    odd = [v for v, d in deg.items() if d % 2 == 1]
    if not odd:
        return total
    k = nx.Graph()
    lengths = {s: nx.single_source_dijkstra_path_length(full, s, weight="weight") for s in odd}
    for a, b in itertools.combinations(odd, 2):
        k.add_edge(a, b, weight=lengths[a][b])
    matching = nx.min_weight_matching(k, weight="weight")
    assert len(matching) * 2 == len(odd)
    return total + sum(lengths[a][b] for a, b in matching)


def brute_force_optimum(g: dict) -> int | None:
    edges = g["edges"]
    m = len(edges)
    base: dict[str, int] = {}
    req_total = 0
    for e in edges:
        if e["required"]:
            req_total += scaled(e["weight"])
            base[e["u"]] = base.get(e["u"], 0) + 1
            base[e["v"]] = base.get(e["v"], 0) + 1
    best = None
    for mask in range(1 << m):
        cost = sum(scaled(edges[i]["weight"]) for i in range(m) if mask >> i & 1)
        if best is not None and cost >= best:
            continue
        deg = dict(base)
        h = nx.MultiGraph()
        for i, e in enumerate(edges):
            if e["required"] or mask >> i & 1:
                h.add_edge(e["u"], e["v"])
            if mask >> i & 1:
                deg[e["u"]] = deg.get(e["u"], 0) + 1
                deg[e["v"]] = deg.get(e["v"], 0) + 1
        if any(d % 2 for d in deg.values()):
            continue
        if h.number_of_nodes() and not nx.is_connected(h):
            continue
        best = cost
    return None if best is None else req_total + best


def check_route(g: dict, res: dict) -> str | None:
    by_id = {e["id"]: e for e in g["edges"]}
    at = res["depot"]
    length = 0
    seen = set()
    for edge_id, frm, to in res["steps"]:
        e = by_id[edge_id]
        if frm != at:
            return f"discontinuity at {edge_id}"
        if {frm, to} != {e["u"], e["v"]}:
            return f"bad orientation {edge_id}"
        at = to
        length += scaled(e["weight"])
        seen.add(edge_id)
    if at != res["depot"]:
        return "not closed"
    missing = [e["id"] for e in g["edges"] if e["required"] and e["id"] not in seen]
    if missing:
        return f"missing {missing}"
    if length != scaled(res["total"]):
        return f"length {length} != total {scaled(res['total'])}"
    return None


def main() -> int:
    rng = random.Random(20261018)
    graphs = []
    for i in range(500):
        graphs.append(random_graph(rng, 7, 11, 0.25))
    for i in range(150):
        graphs.append(random_graph(rng, 40, 90, 0.2))
    proc = subprocess.run(
        ["npx", "--yes", "tsx", os.path.join(HERE, "solve_batch.ts")],
        input=json.dumps({"graphs": graphs, "includeExamples": True}).encode(),
        capture_output=True,
        cwd=ROOT,
        check=False,
    )
    if proc.returncode != 0:
        print(proc.stderr.decode(), file=sys.stderr)
        return 2
    results = json.loads(proc.stdout)["results"]
    failures = []
    compared_nx = compared_bf = rejected = 0
    for idx, res in enumerate(results):
        g = graphs[idx] if idx < len(graphs) else res["graph"]
        connected = required_connected(g)
        if not res["ok"]:
            rejected += 1
            if connected and "LIMIT_EXCEEDED" not in res["codes"]:
                failures.append((res["name"], f"SWEEP rejected a solvable graph: {res['codes']}"))
            continue
        if not connected:
            failures.append((res["name"], "SWEEP solved a graph whose required edges are disconnected"))
            continue
        if not res["checksPassed"]:
            failures.append((res["name"], "SWEEP reported a failed check"))
        err = check_route(g, res)
        if err:
            failures.append((res["name"], err))
        nx_opt = networkx_optimum(g)
        compared_nx += 1
        if nx_opt != scaled(res["total"]):
            failures.append((res["name"], f"networkx optimum {nx_opt / SCALE} != SWEEP {res['total']}"))
        if len(g["edges"]) <= 12:
            bf = brute_force_optimum(g)
            compared_bf += 1
            if bf != scaled(res["total"]):
                failures.append((res["name"], f"brute force {bf} != SWEEP {res['total']}"))
    print(f"oracle: {len(results)} graphs · {compared_nx} compared with networkx · {compared_bf} with brute force · {rejected} rejected (all verified as genuinely disconnected)")
    if failures:
        for name, msg in failures[:20]:
            print(f"FAIL {name}: {msg}")
        print(f"{len(failures)} failure(s)")
        return 1
    print("oracle: all comparisons agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
