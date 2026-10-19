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

Directed and mixed networks (one-way streets) are checked separately:

3. networkx min_cost_flow: sum(required arcs) + the cheapest flow that balances
   in- and out-degrees over all permitted arcs (network simplex; SWEEP uses
   successive shortest paths). Used for every 'both' instance.
4. state-space Dijkstra over (vertex, set of serviced obligations): a plain
   shortest closed walk that relies on no postman theory at all. Used for small
   'both' and all 'either' (mixed) instances.

Their routes are re-walked too, including the permitted direction of every step.

Run:  python3 -I oracle/run_oracle.py      (needs: pip install -r oracle/requirements.txt)
"""
from __future__ import annotations

import heapq
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


# ----------------------------------------------------------------- directed


def random_directed_graph(rng: random.Random, max_n: int, max_m: int) -> dict:
    n = rng.randint(2, max_n)
    m = rng.randint(1, max_m)
    vertices = [{"id": f"v{i}", "x": rng.randint(0, 500), "y": rng.randint(0, 500)} for i in range(n)]
    edges = []
    for k in range(m):
        u = rng.randrange(n)
        v = rng.randrange(n)
        if u == v:
            v = (v + 1) % n
        e = {"id": f"e{k}", "u": f"v{u}", "v": f"v{v}", "weight": rng.randint(0, 40) + (0.5 if rng.random() < 0.2 else 0), "required": rng.random() >= 0.25}
        if rng.random() < 0.45:
            e["oneway"] = True
        elif rng.random() < 0.3:
            e["reverseWeight"] = rng.randint(0, 40)
        edges.append(e)
    return {"vertices": vertices, "edges": edges}


def permitted_arcs(g: dict) -> list[tuple[str, str, int, str, bool]]:
    """(tail, head, scaled cost, street id, forwards) for every legal direction of travel."""
    arcs = []
    for e in g["edges"]:
        arcs.append((e["u"], e["v"], scaled(e["weight"]), e["id"], True))
        if not (e.get("oneway") or e.get("directed")):
            arcs.append((e["v"], e["u"], scaled(e.get("reverseWeight", e["weight"])), e["id"], False))
    return arcs


def obligations(g: dict, two_way: str) -> list[set[tuple[str, bool]]]:
    """Each obligation is the set of (street, forwards) traversals that discharge it."""
    out: list[set[tuple[str, bool]]] = []
    for e in g["edges"]:
        if not e["required"]:
            continue
        if e.get("oneway") or e.get("directed"):
            out.append({(e["id"], True)})
        elif two_way == "both":
            out.append({(e["id"], True)})
            out.append({(e["id"], False)})
        else:
            out.append({(e["id"], True), (e["id"], False)})
    return out


def default_depot(g: dict) -> str | None:
    touched = {x for e in g["edges"] if e["required"] for x in (e["u"], e["v"])}
    return next((v["id"] for v in g["vertices"] if v["id"] in touched), None)


def directed_feasible(g: dict, depot: str) -> bool:
    """A closed walk from the depot can service everything iff every required vertex shares its SCC."""
    d = nx.DiGraph()
    d.add_nodes_from(v["id"] for v in g["vertices"])
    d.add_edges_from((t, h) for t, h, *_ in permitted_arcs(g))
    comp = next(c for c in nx.strongly_connected_components(d) if depot in c)
    return all(x in comp for e in g["edges"] if e["required"] for x in (e["u"], e["v"]))


def flow_optimum(g: dict) -> int:
    """'both' semantics: required arcs + networkx minimum-cost balancing flow."""
    balance: dict[str, int] = {}
    total = 0
    by_key = {(eid, fwd): (t, h, c) for t, h, c, eid, fwd in permitted_arcs(g)}
    for ob in obligations(g, "both"):
        (key,) = ob
        t, h, c = by_key[key]
        total += c
        balance[h] = balance.get(h, 0) + 1
        balance[t] = balance.get(t, 0) - 1
    d = nx.DiGraph()
    for v in g["vertices"]:
        d.add_node(v["id"], demand=-balance.get(v["id"], 0))
    for t, h, c, _eid, _fwd in permitted_arcs(g):
        if t == h:
            continue
        if d.has_edge(t, h):
            d[t][h]["weight"] = min(d[t][h]["weight"], c)
        else:
            d.add_edge(t, h, weight=c)
    return total + nx.min_cost_flow_cost(d)


def state_optimum(g: dict, two_way: str, depot: str) -> int | None:
    """Shortest closed walk from the depot that discharges every obligation (Dijkstra on states)."""
    obs = obligations(g, two_way)
    sat: dict[tuple[str, bool], int] = {}
    for i, ob in enumerate(obs):
        for key in ob:
            sat[key] = sat.get(key, 0) | (1 << i)
    out: dict[str, list[tuple[str, int, int]]] = {}
    for t, h, c, eid, fwd in permitted_arcs(g):
        out.setdefault(t, []).append((h, c, sat.get((eid, fwd), 0)))
    full = (1 << len(obs)) - 1
    dist = {(depot, 0): 0}
    pq = [(0, depot, 0)]
    while pq:
        d0, v, mask = heapq.heappop(pq)
        if d0 > dist[(v, mask)]:
            continue
        if v == depot and mask == full:
            return d0
        for h, c, s in out.get(v, []):
            key = (h, mask | s)
            if d0 + c < dist.get(key, 1 << 62):
                dist[key] = d0 + c
                heapq.heappush(pq, (d0 + c, h, mask | s))
    return None


def check_directed_route(g: dict, res: dict, two_way: str) -> str | None:
    by_id = {e["id"]: e for e in g["edges"]}
    at = res["depot"]
    length = 0
    done: set[tuple[str, bool]] = set()
    for edge_id, frm, to in res["steps"]:
        e = by_id[edge_id]
        if frm != at:
            return f"discontinuity at {edge_id}"
        if (frm, to) == (e["u"], e["v"]):
            fwd = True
        elif (frm, to) == (e["v"], e["u"]) and not (e.get("oneway") or e.get("directed")):
            fwd = False
        else:
            return f"illegal direction on {edge_id} ({frm} -> {to})"
        length += scaled(e["weight"]) if fwd else scaled(e.get("reverseWeight", e["weight"]))
        done.add((edge_id, fwd))
        at = to
    if at != res["depot"]:
        return "not closed"
    unmet = [sorted(ob) for ob in obligations(g, two_way) if not (ob & done)]
    if unmet:
        return f"unserviced {unmet[:4]}"
    if length != scaled(res["total"]):
        return f"length {length} != total {scaled(res['total'])}"
    return None


STATE_MAX_OBLIGATIONS = 11


def main() -> int:
    rng = random.Random(20261018)
    graphs = []
    for i in range(500):
        graphs.append(random_graph(rng, 7, 11, 0.25))
    for i in range(150):
        graphs.append(random_graph(rng, 40, 90, 0.2))
    directed = []
    for i in range(700):
        directed.append({"graph": random_directed_graph(rng, 7, 8), "twoWay": "both"})
    for i in range(500):
        directed.append({"graph": random_directed_graph(rng, 6, 8), "twoWay": "either"})
    for i in range(200):
        directed.append({"graph": random_directed_graph(rng, 30, 70), "twoWay": "both"})
    local_tsx = os.path.join(ROOT, "node_modules", ".bin", "tsx")
    runner = [local_tsx] if os.path.exists(local_tsx) else ["npx", "--yes", "tsx"]
    proc = subprocess.run(
        runner + [os.path.join(HERE, "solve_batch.ts")],
        input=json.dumps({"graphs": graphs, "directed": directed, "includeExamples": True}).encode(),
        capture_output=True,
        cwd=ROOT,
        check=False,
    )
    if proc.returncode != 0:
        print(proc.stderr.decode(), file=sys.stderr)
        return 2
    payload = json.loads(proc.stdout)
    results = payload["results"]
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

    d_flow = d_state = d_rejected = 0
    for idx, res in enumerate(payload["directedResults"]):
        g = directed[idx]["graph"] if idx < len(directed) else res["graph"]
        two_way = res["twoWay"]
        depot = res["depot"] if res["ok"] else default_depot(g)
        connected = required_connected(g)
        feasible = connected and depot is not None and directed_feasible(g, depot)
        if not res["ok"]:
            d_rejected += 1
            allowed = {"LIMIT_EXCEEDED", "MIXED_TOO_LARGE"}
            if feasible and not allowed.intersection(res["codes"]):
                failures.append((res["name"], f"SWEEP rejected a solvable directed graph: {res['codes']}"))
            continue
        if not feasible:
            failures.append((res["name"], "SWEEP solved a directed graph that has no legal covering closed walk (or disconnected required streets)"))
            continue
        if not res["checksPassed"]:
            failures.append((res["name"], "SWEEP reported a failed check (directed)"))
        err = check_directed_route(g, res, two_way)
        if err:
            failures.append((res["name"], err))
        if two_way == "both":
            opt = flow_optimum(g)
            d_flow += 1
            if opt != scaled(res["total"]):
                failures.append((res["name"], f"networkx min-cost-flow optimum {opt / SCALE} != SWEEP {res['total']}"))
        if len(obligations(g, two_way)) <= STATE_MAX_OBLIGATIONS:
            opt = state_optimum(g, two_way, depot)
            d_state += 1
            if opt != scaled(res["total"]):
                failures.append((res["name"], f"state-space optimum {None if opt is None else opt / SCALE} != SWEEP {res['total']}"))
    print(
        f"oracle (directed/mixed): {len(payload['directedResults'])} graphs · {d_flow} compared with networkx min-cost flow · "
        f"{d_state} with state-space search · {d_rejected} rejected (all verified as genuinely infeasible or disconnected)"
    )
    if failures:
        for name, msg in failures[:20]:
            print(f"FAIL {name}: {msg}")
        print(f"{len(failures)} failure(s)")
        return 1
    print("oracle: all comparisons agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
