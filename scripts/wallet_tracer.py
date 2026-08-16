#!/usr/bin/env python3
"""
USDT Wallet Tracer
==================
Pull PUBLIC on-chain data for a wallet across Ethereum AND Binance Smart Chain
and compute well-known scam red-flag heuristics, then produce a risk report.

This tool ONLY reads public data (no credentials needed) and produces
*indicators* for you to evaluate — it does NOT make a legal determination
of guilt. Use it as one input alongside your own investigation (per your
CompTIA Security+ training: verify, correlate, and judge).

Data sources (public, keyless):
  - Public JSON-RPC nodes for Ethereum and BNB Smart Chain
    * balances: eth_getBalance
    * nonce:    eth_getTransactionCount
    * USDT bal: eth_call balanceOf
    * USDT history: eth_getLogs on the USDT Transfer topic

Usage:
  python3 wallet_tracer.py 0x2817E7440bDf8709f3a8c3Ce7633F79e55086b0a
  python3 wallet_tracer.py 0x... --limit 500 --json
  python3 wallet_tracer.py 0x... --chain bsc --html --output /tmp/report.html

Flags:
  --limit N   max USDT transfers to analyze per chain (default 500)
  --json      emit raw JSON report instead of human-readable
  --html      emit a self-contained, styled HTML report
  --output F  write the report to file F (implies --html)
  --chain C   only check a specific chain (eth | bsc)
  --quiet     suppress progress noise
"""

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone

# --- Chain definitions -------------------------------------------------------
USDT_MAINNET = "0xdac17f958d2ee523a2206206994597c13d831ec7"  # ERC-20 USDT
USDT_BSC = "0x55d398326f99059ff775485246999027b3197955"        # BEP-20 USDT
USDT_OLD = "0x8e870d67f660d95d5be530380d0ec0bd388289e1"        # old ERC-20 USDT

CHAINS = {
    "eth": {
        "rpc": "https://ethereum.publicnode.com",
        "name": "Ethereum",
        "native": "ETH",
        "decimals": 18,
        "usdt": USDT_MAINNET,
        "usdt_decimals": 6,
        "usdt_extra": [("USDT_old", USDT_OLD, 6)],
        "etherscan": "https://etherscan.io",
        "api_host": "https://api.etherscan.io/api",
        "block_sec": 12.0,
    },
    "bsc": {
        "rpc": "https://bsc-dataseed1.binance.org",
        "name": "BNB Smart Chain",
        "native": "BNB",
        "decimals": 18,
        "usdt": USDT_BSC,
        "usdt_decimals": 18,
        "usdt_extra": [],
        "etherscan": "https://bscscan.com",
        "api_host": "https://api.bscscan.com/api",
        "block_sec": 3.0,
    },
}

# Public, keyless JSON-RPC endpoint (default ETH; per-chain in CHAINS).
RPC = CHAINS["eth"]["rpc"]

# --- Well-known hashes (public constants) ---
# keccak256("Transfer(address,address,uint256)") topic
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
# USDT balanceOf(address) selector: 0x70a08231
BALANCEOF_SEL = "0x70a08231"

# A small curated set of well-known sanctioned / high-risk addresses on Ethereum.
# These are the widely-publicized Tornado Cash mixer addresses etc. (public info).
KNOWN_HIGH_RISK = {
    "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf": "Tornado Cash Pool",
    "0x8589427373d6d84e98730d7795d8f6f8731fda16": "Tornado Cash Pool",
    "0x722122df12d4e14e13ac3b6895a86e84145b6967": "Tornado Cash Router",
    "0x23773e65ed146a459791799d01336db287f25334": "Tornado Cash Rewarder",
    "0xd90e2f925da726b50c4cf8c0ab06800f2a843e8a": "Tornado Cash REWARDS",
    "0x1e34a77868e19a6647b1f2f47b51ed72dede95dd": "Tornado Cash",
    "0xdf231d99ff8b6c6cbf4e9b9a945cbacef9339178": "Tornado Cash",
    "0xaf4c0b70b2ea9fb7487c7cbb37ada259579fe040": "Tornado Cash 5",
    "0xa5c2254e4253490c46ce28a0ffff258604aefb68": "HitBTC (exchange, verify)",
    "0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503": "Binance (exchange, verify)",
    "0xf977814e90da44bfa03b6295a0616a897441acec": "Binance (exchange, verify)",
}
# NOTE: exchange addresses are NOT inherently "scammers" — they're included as
# "counterparty classification" info only; they do NOT raise risk on their own.
HIGH_RISK_RED = {a: l for a, l in KNOWN_HIGH_RISK.items()
                 if l.lower().startswith("tornado")}   # only mixers raise risk


# --- Data pull (JSON-RPC) ---------------------------------------------------
def convert_ts(ts):
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except Exception:
        return str(ts)


def get_balance_wei(address, chain="eth", quiet=False):
    d = rpc("eth_getBalance", [rpc_eth_addr(address), "latest"], chain=chain)
    if not quiet:
        print(f"    RPC {CHAINS[chain]['name']} eth_getBalance")
    return hex_to_int(d.get("result", "0x0"))


def get_nonce(address, chain="eth", quiet=False):
    d = rpc("eth_getTransactionCount", [rpc_eth_addr(address), "latest"], chain=chain)
    if not quiet:
        print(f"    RPC {CHAINS[chain]['name']} eth_getTransactionCount")
    return hex_to_int(d.get("result", "0x0"))


def get_token_balance_wei(token, address, chain="eth", quiet=False):
    # balanceOf(address) packed as 32-byte padded arg
    arg = address.lower().replace("0x", "").rjust(64, "0")
    data = BALANCEOF_SEL + arg
    d = rpc("eth_call", [{"to": rpc_eth_addr(token), "data": data}, "latest"], chain=chain)
    if not quiet:
        print(f"    RPC {CHAINS[chain]['name']} eth_call balanceOf({token[:10]}...)")
    return hex_to_int(d.get("result", "0x0"))


def explorer_get_token_transfers(address, chain, limit, apikey=None):
    """Use the public explorer API (Etherscan/BscScan) for token tx history."""
    C = CHAINS[chain]
    if not apikey:
        return None  # signal: try RPC
    params = {
        "module": "account", "action": "tokentx",
        "address": address, "startblock": 0, "endblock": 99999999,
        "page": 1, "offset": min(limit, 10000), "sort": "desc",
        "apikey": apikey,
    }
    url = C["api_host"] + "?" + urllib.parse.urlencode(params)
    try:
        d = json.loads(http_get(url))
    except Exception:
        return None
    if isinstance(d, dict) and d.get("status") == "1" and isinstance(d.get("result"), list):
        return d["result"]
    return None


def get_token_transfers(token, address, limit, chain="eth", quiet=False, apikey=None):
    """USDT transfer history. Prefers explorer API (needs free key); else RPC eth_getLogs.

    Returns (list_of_items, note) where note explains any data gap.
    """
    note = None
    # Try explorer API first (rich history in one call)
    ex = explorer_get_token_transfers(address, chain, limit, apikey)
    if ex is not None:
        out = []
        for t in ex:
            try:
                block = int(t.get("blockNumber", 0))
            except Exception:
                block = 0
            try:
                val = float(t.get("value", 0)) / (10 ** CHAINS[chain]["usdt_decimals"])
            except Exception:
                val = 0.0
            from_a = (t.get("from") or "").lower()
            to_a = (t.get("to") or "").lower()
            kind = "in" if to_a == address.lower() else "out"
            c = (t.get("contractAddress") or "").lower()
            if c and c != token.lower():
                continue
            out.append({"kind": kind, "from": from_a, "to": to_a,
                        "value_usdt": round(val, 4), "block": block,
                        "tx_hash": t.get("hash")})
        out.sort(key=lambda r: r["block"], reverse=True)
        if not quiet:
            print(f"    Explorer {CHAINS[chain]['name']} tokentx ({len(out)} records)")
        return out[:limit], note

    # Fallback: RPC eth_getLogs
    if not quiet:
        print(f"    RPC {CHAINS[chain]['name']} eth_getLogs (USDT Transfer)")
    from_addr = address.lower().replace("0x", "").rjust(64, "0")
    out = []
    for topic_key, kind in ((from_addr, "out"), (None, "in")):
        topics = [TRANSFER_TOPIC, topic_key, None] if kind == "out" \
            else [TRANSFER_TOPIC, None, from_addr]
        d = rpc("eth_getLogs", [{
            "address": rpc_eth_addr(token),
            "topics": topics,
            "fromBlock": "0x0", "toBlock": "latest",
        }], chain=chain)
        if d.get("error"):
            note = f"{CHAINS[chain]['name']} eth_getLogs blocked by node: {d['error'].get('message','?')}"
            continue
        logs = d.get("result")
        if isinstance(logs, list):
            for lg in logs:
                out.append({"kind": kind, "log": lg})
    if note == "0x0":
        note = None
    # sort desc
    def blk(item):
        lg = item.get("log", {})
        try:
            return int(lg["blockNumber"], 16)
        except Exception:
            return 0
    out.sort(key=blk, reverse=True)
    return out[:limit], note


# --- JSON-RPC plumbing -------------------------------------------------------
def http_get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "wallet-tracer/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


_rpc_id = 0


def rpc_eth_addr(addr):
    """Ethereum addresses in RPC params must be checksummed or all-lowercase hex."""
    return addr.lower()


def hex_to_int(h):
    try:
        return int(h, 16)
    except Exception:
        return 0


def rpc(method, params, chain="eth", quiet=True):
    global _rpc_id
    _rpc_id += 1
    endpoint = CHAINS[chain]["rpc"]
    body = json.dumps({"jsonrpc": "2.0", "method": method,
                       "params": params, "id": _rpc_id}).encode()
    req = urllib.request.Request(
        endpoint, data=body,
        headers={"Content-Type": "application/json",
                 "User-Agent": "wallet-tracer/1.0"},
        method="POST")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:
            if attempt == 2:
                return {"error": {"message": str(e)}}
            time.sleep(1.5)
    return {"error": {"message": "rpc failed"}}


# --- Heuristics --------------------------------------------------------------
def analyze(address, limit=200, quiet=False, chains=None, apikey=None):
    alias = address.lower()
    if chains is None:
        chains = ["eth", "bsc"]
    report = {
        "address": address,
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "disclaimer": "Indicators only; not a determination of guilt.",
        "chains": {},
        "flags": [],
        "risk_score": 0,
        "apikey_used": bool(apikey),
    }

    for chain in chains:
        C = CHAINS[chain]
        cname = C["name"]
        out = {
            "chain": chain,
            "name": cname,
            "native_balance": 0.0,
            "nonce": 0,
            "usdt_balance": 0.0,
            "usdt_transfer_count": 0,
            "usdt_in_total": 0.0,
            "usdt_out_total": 0.0,
            "usdt_transfer_list": [],
            "span_blocks": None,
            "span_days_est": None,
            "first_seen": None,
            "last_seen": None,
            "etherscan": C["etherscan"],
        }

        if not quiet:
            print(f"\n--- {cname} ---")

        # Native balance + nonce
        wei = get_balance_wei(address, chain=chain, quiet=quiet)
        out["native_balance"] = wei / (10 ** C["decimals"])
        out["nonce"] = get_nonce(address, chain=chain, quiet=quiet)

        # USDT main balance
        usdt_wei = get_token_balance_wei(C["usdt"], address, chain=chain, quiet=quiet)
        extra_bal = {}
        try:
            for sym, tok, dec in C["usdt_extra"]:
                extra_bal[sym] = get_token_balance_wei(tok, address, chain=chain, quiet=True) / (10 ** dec)
        except Exception:
            pass
        out["extra_token_balances"] = extra_bal
        out["usdt_balance"] = usdt_wei / (10 ** C["usdt_decimals"])

        # USDT transfer history
        transfers, note = get_token_transfers(C["usdt"], address, limit,
                                              chain=chain, quiet=quiet, apikey=apikey)
        out["usdt_transfer_count"] = len(transfers)
        out["data_note"] = note

        usdt_in = 0.0
        usdt_out = 0.0
        counterparties = Counter()
        times = []
        for t in transfers:
            # Explorer-API items are pre-decoded; RPC items carry a `log`.
            if "log" in t:
                lg = t.get("log", {})
                try:
                    addr_from = ("0x" + lg["topics"][1][-40:]).lower()
                    addr_to = ("0x" + lg["topics"][2][-40:]).lower()
                    value = hex_to_int(lg.get("data", "0x0")) / (10 ** C["usdt_decimals"])
                    block = hex_to_int(lg.get("blockNumber"))
                    tx_hash = lg.get("transactionHash")
                    kind = t["kind"]
                except Exception:
                    continue
            else:
                addr_from = t.get("from", "")
                addr_to = t.get("to", "")
                value = t.get("value_usdt", 0.0)
                block = t.get("block", 0)
                tx_hash = t.get("tx_hash")
                kind = t.get("kind", "in" if addr_to == alias else "out")
            counterparties[addr_from] += 1
            counterparties[addr_to] += 1
            rec = {"kind": kind, "from": addr_from, "to": addr_to,
                   "value_usdt": round(value, 4), "block": block, "tx_hash": tx_hash}
            out["usdt_transfer_list"].append(rec)
            if kind == "in":
                usdt_in += value
            else:
                usdt_out += value
            times.append(block)

        out["usdt_in_total"] = round(usdt_in, 2)
        out["usdt_out_total"] = round(usdt_out, 2)

        chain_flags = []
        # Mixer counterparty
        for addr, label in HIGH_RISK_RED.items():
            if addr in counterparties:
                chain_flags.append({"severity": "CRITICAL", "type": "known_mixer_counterparty",
                                    "detail": f"[{cname}] Interacted with known '{label}' ({addr})"})
                report["risk_score"] += 40
        # Nonce 0 but token flow
        if out["nonce"] == 0 and (usdt_in > 0 or usdt_out > 0):
            chain_flags.append({"severity": "HIGH", "type": "zero_nonce_but_token_flow",
                                "detail": f"[{cname}] USDT moves but native nonce=0"})
            report["risk_score"] += 15
        # Pass-through
        if usdt_in > 0 and usdt_out > 0 and usdt_out >= 0.9 * usdt_in:
            chain_flags.append({
                "severity": "MEDIUM", "type": "pass_through_wallet",
                "detail": f"[{cname}] USDT pass-through in {usdt_in:,.2f} / out {usdt_out:,.2f} "
                          f"({abs(usdt_out / usdt_in) * 100:.0f}% out)"})
            report["risk_score"] += 15
        # Self-sends
        self_loops = sum(1 for r in out["usdt_transfer_list"] if r["from"] == r["to"] == alias)
        if self_loops:
            chain_flags.append({"severity": "LOW", "type": "self_sends",
                                "detail": f"[{cname}] {self_loops} self-send(s)"})
            report["risk_score"] += 3
        # Accumulator
        if usdt_in > 0 and usdt_out == 0:
            chain_flags.append({"severity": "INFO", "type": "accumulator",
                                "detail": f"[{cname}] accumulates USDT (in {usdt_in:,.2f}, out 0)"})
        out["flags"] = chain_flags

        if times:
            first_b, last_b = min(times), max(times)
            out["span_blocks"] = last_b - first_b
            out["span_days_est"] = round((last_b - first_b) * C["block_sec"] / 86400, 2)
            out["first_seen"] = first_b
            out["last_seen"] = last_b

        report["chains"][chain] = out

    # Overall first/last
    firsts, lasts = [], []
    for ch in report["chains"].values():
        if ch["first_seen"]:
            firsts.append(ch["first_seen"])
            lasts.append(ch["last_seen"])
    if firsts:
        report["first_seen_block"] = min(firsts)
        report["last_seen_block"] = max(lasts)

    return report


# --- Network topology / "edge node" analysis ---------------------------------
def _gini(xs):
    """Gini coefficient (0 = equal, 1 = fully concentrated)."""
    xs = [x for x in xs if x > 0]
    if not xs:
        return 0.0
    xs = sorted(xs)
    n = len(xs)
    s = sum(xs)
    if s <= 0:
        return 0.0
    cum = 0.0
    for i, x in enumerate(xs, 1):
        cum += i * x
    return (2 * cum / (n * s)) - (n + 1) / n


def node_role(chain_node):
    """Classify an address's topology role in the fund-flow graph.

    Returns short code, label, and a human explanation.
    """
    in_deg = chain_node["in_degree"]
    out_deg = chain_node["out_degree"]
    total_in = chain_node["total_in"]
    total_out = chain_node["total_out"]
    top_out_share = chain_node.get("top_out_share", 0.0)

    # Pure collector (only ever receives)
    if in_deg > 0 and out_deg == 0:
        return ("SINK", "Sink / pure collector",
                "Receives USDT from {} funder(s) but never sends - terminal deposit point."
                .format(in_deg))
    # Pure source (only ever sends) - e.g. an outgoing paymaster
    if in_deg == 0 and out_deg > 0:
        return ("SOURCE", "Source / paymaster",
                "Only sends USDT to {} receiver(s) - origin of funds.".format(out_deg))
    if in_deg == 0 and out_deg == 0:
        return ("IDLE", "Idle", "No USDT flow observed.")

    # Both directions present -> decide leaf vs hub vs relay by concentration
    # EDGE/LEAF: funnels inflow to a single dominant collector (top_out_share high)
    if out_deg >= 1 and top_out_share >= 0.9:
        return ("EDGE-LEAF", "Edge / leaf (funnels to 1 dominant collector)",
                "{} funder(s) in, but {:.0f}% of outflows go to a single address - "
                "this looks like an edge node feeding one collector upstream."
                .format(in_deg, top_out_share * 100))
    # RELAY: comparable many-to-many, net roughly balanced
    if in_deg >= 2 and out_deg >= 2:
        return ("RELAY", "Relay / through-point",
                "{} funders -> {} receivers with moderate concentration - a pass-through relay."
                .format(in_deg, out_deg))
    # HUB: many outbound, few inbound - distributes funds widely
    if out_deg > in_deg:
        return ("HUB", "Hub / distributor",
                "Distributes to {} receiver(s) from {} funder(s) - a dispersal point."
                .format(out_deg, in_deg))
    # Otherwise fallback (small funnel, e.g. 1->2)
    return ("FUNNEL", "Small funnel",
            "{} -> {} with top receiver taking {:.0f}%."
            .format(in_deg, out_deg, top_out_share * 100))


def map_network(report, max_neighbors=25):
    """Build a fund-flow graph per chain and classify the queried node + top neighbors.

    Mutates `report['chain_map']`. Returns the same report (convenience).
    """
    alias = report["address"].lower()
    report["chain_map"] = {}
    if not report.get("chains"):
        return report

    for chain, ch in report["chains"].items():
        transfers = ch.get("usdt_transfer_list") or []
        # in/out edges: {counterparty: {in: usd, out: usd, tx: n}}
        flow = {}  # addr -> {"in":0,"out":0,"n_in":0,"n_out":0}
        nodes = {alias: {"in": 0.0, "out": 0.0, "n_in": 0, "n_out": 0}}
        for t in transfers:
            fr = (t.get("from") or "").lower()
            to = (t.get("to") or "").lower()
            val = t.get("value_usdt") or 0.0
            nodes.setdefault(fr, {"in": 0.0, "out": 0.0, "n_in": 0, "n_out": 0})
            nodes.setdefault(to, {"in": 0.0, "out": 0.0, "n_in": 0, "n_out": 0})
            # direction through the queried alias
            if to == alias:
                nodes[fr]["in"] += val
                nodes[fr]["n_in"] += 1
            if fr == alias:
                nodes[to]["out"] += val
                nodes[to]["n_out"] += 1
            # also, if edge is between queried and a neighbour the reverse bookkeeping:
            if fr == alias:
                nodes[alias]["out"] += val
                nodes[alias]["n_out"] += 1
            if to == alias:
                nodes[alias]["in"] += val
                nodes[alias]["n_in"] += 1

        me = nodes[alias]
        in_neighbors = [a for a, d in nodes.items() if a != alias and d["in"] > 0]
        out_neighbors = [a for a, d in nodes.items() if a != alias and d["out"] > 0]

        top_out_val = 0.0
        if out_neighbors:
            top_out_val = max(nodes[a]["out"] for a in out_neighbors)
        top_out_share = (top_out_val / me["out"]) if me["out"] > 0 else 0.0

        in_amounts = [nodes[a]["in"] for a in in_neighbors]
        out_amounts = [nodes[a]["out"] for a in out_neighbors]

        node = {
            "in_degree": len(in_neighbors),
            "out_degree": len(out_neighbors),
            "total_in": round(me["in"], 2),
            "total_out": round(me["out"], 2),
            "net": round(me["in"] - me["out"], 2),
            "top_out_share": round(top_out_share, 4),
            "gini_in": round(_gini(in_amounts), 3),
            "gini_out": round(_gini(out_amounts), 3),
            "in_neighbors": sorted(in_neighbors, key=lambda a: -nodes[a]["in"])[:max_neighbors],
            "out_neighbors": sorted(out_neighbors, key=lambda a: -nodes[a]["out"])[:max_neighbors],
            "neighbor_flows": {a: {"in": round(nodes[a]["in"], 2),
                                   "out": round(nodes[a]["out"], 2),
                                   "n_in": nodes[a]["n_in"], "n_out": nodes[a]["n_out"]}
                               for a in in_neighbors + out_neighbors},
        }
        code, label, expl = node_role(node)
        node["role_code"] = code
        node["role"] = label
        node["role_explanation"] = expl

        report["chain_map"][chain] = node

        # Surface a flag when the node is a leaf/funnel feeding one collector
        if code in ("EDGE-LEAF", "FUNNEL"):
            report.setdefault("flags", []).append({
                "severity": "HIGH",
                "type": "edge_node_funnel",
                "detail": f"[{chain}] {label}: {node['in_degree']} funder(s) in, "
                          f"{node['out_degree']} receiver(s) out, "
                          f"top receiver takes {node['top_out_share']*100:.0f}%",
            })
            report["risk_score"] = report.get("risk_score", 0) + 20
        elif code == "SINK":
            report.setdefault("flags", []).append({
                "severity": "INFO",
                "type": "sink_collector",
                "detail": f"[{chain}] {label}: {node['in_degree']} funder(s), never sends",
            })
    return report


def trace_two_hop(report, chains, apikey, max_neighbors=8, max_hops=2, quiet=False):
    """Expand the top outbound neighbor(s) one more hop to see if funds fan out further.

    Only possible when an API key (or a node allowing getLogs) is available.
    Returns a list of 2-hop edge records and updates report['two_hop'].
    """
    alias = report["address"].lower()
    report["two_hop"] = {}
    for chain in chains:
        ch = report["chains"].get(chain)
        if not ch:
            continue
        node = report.get("chain_map", {}).get(chain)
        if not node or not node["out_neighbors"]:
            continue
        hub = node["out_neighbors"][0]  # dominant collector
        C = CHAINS[chain]
        transfers, note = get_token_transfers(C["usdt"], hub, limit=500,
                                              chain=chain, quiet=quiet, apikey=apikey)
        out = {"collector": hub, "transfers": [], "note": note}
        # decode, same as analyze
        usdt_out = 0.0
        receivers = Counter()
        if "log" in (transfers[0] if transfers else {}):
            for t in transfers:
                lg = t.get("log", {})
                try:
                    addr_from = ("0x" + lg["topics"][1][-40:]).lower()
                    addr_to = ("0x" + lg["topics"][2][-40:]).lower()
                    value = hex_to_int(lg.get("data", "0x0")) / (10 ** C["usdt_decimals"])
                except Exception:
                    continue
                out["transfers"].append({"kind": t["kind"], "from": addr_from,
                                         "to": addr_to, "value_usdt": round(value, 4)})
                if addr_from == hub.lower():
                    receivers[addr_to] += value
                    usdt_out += value
        else:
            for t in transfers:
                out["transfers"].append(t)
                if (t.get("from") or "").lower() == hub.lower():
                    receivers[t.get("to", "")] += t.get("value_usdt", 0)
                    usdt_out += t.get("value_usdt", 0)
        out["collector_out_degree"] = len(receivers)
        out["collector_top_receiver_share"] = round(
            (max(receivers.values()) / usdt_out) if usdt_out > 0 else 0.0, 4)
        top_recv = receivers.most_common(max_neighbors)
        out["top_receivers"] = [{"address": a, "usdt": round(v, 2)} for a, v in top_recv]
        report["two_hop"][chain] = out
    return report


# --- Rendering ---------------------------------------------------------------
def render(report):
    R = report
    print("=" * 72)
    print("USDT WALLET TRACER — PUBLIC-CHAIN RISK REPORT (multi-chain)")
    print("=" * 72)
    print(f"Address      : {R['address']}")
    print(f"Generated    : {R['generated_utc']} UTC")
    print(f"Disclaimer   : {R['disclaimer']}")
    print("-" * 72)

    for chain, ch in R["chains"].items():
        print(f"--- {ch['name']} ({chain}) ---")
        print(f"  Native balance     : {ch['native_balance']:.6f}")
        print(f"  Native txn (nonce) : {ch['nonce']}")
        print(f"  USDT balance       : {ch['usdt_balance']:,.4f}")
        for sym, val in (ch.get("extra_token_balances") or {}).items():
            if val:
                print(f"  {sym} balance     : {val:,.4f}")
        print(f"  USDT transfers     : {ch['usdt_transfer_count']}")
        print(f"  USDT in total      : {ch.get('usdt_in_total',0):,.2f}")
        print(f"  USDT out total     : {ch.get('usdt_out_total',0):,.2f}")
        if ch.get("data_note"):
            print(f"  !! NOTE            : {ch['data_note']}")
        if ch.get("first_seen"):
            print(f"  First/last (block) : {ch['first_seen']} / {ch['last_seen']} "
                  f"(span ~{ch.get('span_days_est')} days)")
        lst = ch.get("usdt_transfer_list") or []
        if lst:
            print("  Recent USDT transfers (newest first):")
            for r in lst[:15]:
                arrow = "<-" if r["kind"] == "in" else "->"
                print(f"    blk {r['block']:>9}  {r['value_usdt']:>14,.4f}  "
                      f"{r['from'][:8]}… {arrow} {r['to'][:8]}…")
        for fl in ch.get("flags", []):
            print(f"    [{fl['severity']:8}] {fl['type']}: {fl['detail']}")
        print(f"  Explorer: {ch['etherscan']}/address/{R['address']}")
        print("-" * 72)

    print(f"RISK SCORE: {R['risk_score']}  "
          f"({'HIGH' if R['risk_score']>=50 else 'ELEVATED' if R['risk_score']>=20 else 'LOW'})")
    nflags = sum(len(ch.get('flags', [])) for ch in R['chains'].values())
    if nflags == 0:
        print("No red-flag indicators found in sampled data.")
    print("=" * 72)
    render_network(report)
    print("HOW TO READ THIS")
    print("  * `nonce` = how many times THIS wallet has SENT a native txn. Nonce 0 +")
    print("    USDT flowing in = it only receives (typical funding/deposit address).")
    print("  * Pass-through / self-sends / fresh-wallet flows are common in mule wallets.")
    print("  * These are INDICATORS — pair with Etherscan/BscScan full tx review.")
    print("NEXT STEPS")
    print("  * Open the Explorer links above and read the full transaction list.")
    print("  * Check the sending/receiving counterparties' own histories.")
    print("  * Never send more funds. Report to the platform/exchange + law enforcement.")
    print("=" * 72)
    render_resources(report)
    print("=" * 72)


def _resources():
    """Curated, stable links for further investigation (3+ per area)."""
    return {
        "general": [
            ("Etherscan (ETH explorer + API key signup)", "https://etherscan.io"),
            ("BscScan (BSC explorer + API key signup)", "https://bscscan.com"),
            ("Ethers.io (multi-chain / token search)", "https://ethers.io"),
        ],
        "scam_check": [
            ("Etherscan AD (Address Database — label/sanction check)", "https://etherscan.io/address-label-cloud"),
            ("Chainabuse — crypto scam & abuse reports", "https://www.chainabuse.com"),
            ("US gov fraud reporting — FTC ReportFraud", "https://reportfraud.ftc.gov"),
            ("IC3 — FBI Internet Crime Complaint Center", "https://www.ic3.gov"),
        ],
        "reverse_lookup": [
            ("AddressWatcher (reverse address lookup)", "https://www.addresswatcher.com/reverse-address-lookup"),
            ("CryptoScamDB", "https://cryptoscamdb.org"),
        ],
    }


def render_resources(report):
    print("RESOURCES & FURTHER LINKS")
    seen = {}
    for chain, ch in (report.get("chains") or {}).items():
        # Dedupe explorer links that already appeared above
        seen[ch["etherscan"]] = ch["name"]
    groups = _resources()
    for name, links in groups.items():
        print(f"  [{name}]")
        for label, url in links:
            print(f"    - {label}: {url}")
    for chain, ch in (report.get("chains") or {}).items():
        print(f"    - {ch['name']} address view: {ch['etherscan']}/address/{report['address']}")


def render_network(report):
    cm = report.get("chain_map") or {}
    if not cm:
        return
    print("\n" + "=" * 72)
    print("FUND-FLOW NETWORK MAP  (edge-node topology)")
    print("=" * 72)
    alias = report["address"].lower()
    for chain, node in cm.items():
        print(f"\n[{chain}] role: {node['role']}")
        print(f"    code            : {node['role_code']}")
        print(f"    in_degree  (#funders)   : {node['in_degree']}")
        print(f"    out_degree (#receivers) : {node['out_degree']}")
        print(f"    total in / out          : {node['total_in']:,.2f} / {node['total_out']:,.2f}  "
              f"(net {node['net']:+,.2f})")
        print(f"    top receiver share      : {node['top_out_share']*100:.0f}%")
        print(f"    gini in / out           : {node['gini_in']:.2f} / {node['gini_out']:.2f}")
        print("    explanation : " + node["role_explanation"])
        if node["in_neighbors"]:
            print("    top funders (IN -> this wallet):")
            for a in node["in_neighbors"][:10]:
                print(f"        {a[:42]}  +{node['neighbor_flows'][a]['in']:>12,.2f}  "
                      f"({node['neighbor_flows'][a]['n_in']}x)")
        if node["out_neighbors"]:
            print("    top receivers (this wallet -> OUT):")
            for a in node["out_neighbors"][:10]:
                print(f"        {a[:42]}  -{node['neighbor_flows'][a]['out']:>12,.2f}  "
                      f"({node['neighbor_flows'][a]['n_out']}x)")

    th = report.get("two_hop") or {}
    for chain, info in th.items():
        print(f"\n[2-hop trace] dominant collector of {chain}: {info['collector']}")
        print(f"    collector out-degree: {info.get('collector_out_degree')}, "
              f"top receiver share: {info.get('collector_top_receiver_share',0)*100:.0f}%")
        for r in info.get("top_receivers", [])[:8]:
            print(f"        {r['address'][:42]}  {r['usdt']:>12,.2f}")
        if info.get("note"):
            print(f"    note: {info['note']}")
    print("=" * 72)


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_html(report):
    """Render the risk report as a self-contained, styled HTML document (string)."""
    R = report
    sev_color = {"CRITICAL": "#f43f5e", "HIGH": "#f97316", "MEDIUM": "#eab308",
                 "LOW": "#60a5fa", "INFO": "#94a3b8"}
    risk = R["risk_score"]
    risk_label = "HIGH" if risk >= 50 else ("ELEVATED" if risk >= 20 else "LOW")
    risk_color = "#f43f5e" if risk >= 50 else ("#f97316" if risk >= 20 else "#22c55e")

    chain_blocks = []
    for chain, ch in R["chains"].items():
        fl_ = ch.get("flags") or []
        lst = ch.get("usdt_transfer_list") or []
        def _pill(sev):
            c = sev_color.get(sev, "#94a3b8")
            return f'<span class="pill" style="background:{c}22;color:{c};border:1px solid {c}55">{_esc(sev)}</span>'
        flag_rows = "".join(
            f'<div class="flag">{_pill(f.get("severity","UNK"))} '
            f'<span class="ftype">{_esc(f.get("type",""))}</span> '
            f'<span class="fdet">{_esc(f.get("detail",""))}</span></div>'
            for f in fl_)
        if not flag_rows:
            flag_rows = '<div class="flag muted">No red-flag indicators in sampled data.</div>'
        tran_rows = "".join(
            f'<tr><td>{_esc(ch.get("name",""))}</td>'
            f'<td class="{"in" if r["kind"]=="in" else "out"}">{"→" if r["kind"]=="in" else "←"} {_esc(r["kind"].upper())}</td>'
            f'<td class="mono">{_esc(r["from"][:10])}…</td><td class="mono">{_esc(r["to"][:10])}…</td>'
            f'<td class="val">{r["value_usdt"]:,.4f}</td>'
            f'<td>{r.get("block","")}</td>'
            f'<td class="mono">{_esc((r.get("tx_hash") or "")[:10])}…</td></tr>'
            for r in lst[:20])
        note = f'<div class="note">⚠ {_esc(ch.get("data_note"))}</div>' if ch.get("data_note") else ""
        extra = "".join(
            f'<div class="stat"><span class="k">{_esc(sym)} balance</span><span class="v">{val:,.4f}</span></div>'
            for sym, val in (ch.get("extra_token_balances") or {}).items() if val)
        span = f'<div class="stat"><span class="k">Activity span</span><span class="v">~{ch.get("span_days_est")} days</span></div>' if ch.get('span_days_est') else ""
        chain_blocks.append(f"""
<section class="card chain">
  <div class="chain-head">
    <h3>{_esc(ch['name'])} <span class="chaintag">{_esc(chain)}</span></h3>
    <a class="link" target="_blank" href="{_esc(ch['etherscan'])}/address/{_esc(R['address'])}">Open explorer ↗</a>
  </div>
  <div class="stats">
    <div class="stat"><span class="k">Native balance</span><span class="v">{ch['native_balance']:,.6f}</span></div>
    <div class="stat"><span class="k">Native txns (nonce)</span><span class="v">{ch['nonce']}</span></div>
    <div class="stat"><span class="k">USDT balance</span><span class="v">{ch['usdt_balance']:,.4f}</span></div>
    {extra}
    <div class="stat"><span class="k">USDT transfers</span><span class="v">{ch['usdt_transfer_count']}</span></div>
    <div class="stat"><span class="k">USDT in total</span><span class="v in">{ch.get('usdt_in_total',0):,.2f}</span></div>
    <div class="stat"><span class="k">USDT out total</span><span class="v out">{ch.get('usdt_out_total',0):,.2f}</span></div>
    <div class="stat"><span class="k">First / last seen</span><span class="v mono">#{ch.get('first_seen','?')} / #{ch.get('last_seen','?')}</span></div>
    {span}
  </div>
  {note}
  <div class="subhead">Flags</div>
  {flag_rows}
  <div class="subhead">Recent USDT transfers (newest first){f' — first {len(lst[:20])} of {len(lst)}' if len(lst)>20 else ''}</div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Chain</th><th>Dir</th><th>From</th><th>To</th><th>USDT</th><th>Block</th><th>Tx</th></tr></thead>
    <tbody>{tran_rows}</tbody>
  </table></div>
</section>""")

    # --- Network / edge-node topology section ---
    cm = R.get("chain_map") or {}
    network_blocks = ""
    if cm:
        role_palette = {"EDGE-LEAF": "#f43f5e", "FUNNEL": "#f97316", "RELAY": "#eab308",
                        "HUB": "#60a5fa", "SINK": "#22c55e", "SOURCE": "#a78bfa",
                        "IDLE": "#94a3b8"}
        blocks = []
        for chain, node in cm.items():
            rolec = role_palette.get(node["role_code"], "#94a3b8")
            fund_rows = "".join(
                f'<div class="neigh"><span class="arrowin">▲ in</span> '
                f'<a class="link mono" target="_blank" '
                f'href="{_esc(CHAINS[chain]["etherscan"])}/address/{_esc(a)}">{_esc(a[:18])}…</a> '
                f'<span class="val">+{node["neighbor_flows"][a]["in"]:,.2f} USDT '
                f'({node["neighbor_flows"][a]["n_in"]}x)</span></div>'
                for a in node["in_neighbors"][:12])
            recv_rows = "".join(
                f'<div class="neigh"><span class="arrow">▼ out</span> '
                f'<a class="link mono" target="_blank" '
                f'href="{_esc(CHAINS[chain]["etherscan"])}/address/{_esc(a)}">{_esc(a[:18])}…</a> '
                f'<span class="val">-{node["neighbor_flows"][a]["out"]:,.2f} USDT '
                f'({node["neighbor_flows"][a]["n_out"]}x)</span></div>'
                for a in node["out_neighbors"][:12])
            blocks.append(f"""
<section class="card">
  <div class="chain-head">
    <h3>Network topology — {_esc(CHAINS[chain]['name'])} <span class="chaintag">{_esc(chain)}</span></h3>
    <span class="role" style="background:{rolec}22;color:{rolec};border:1px solid {rolec}55">{_esc(node['role'])}</span>
  </div>
  <div class="stats">
    <div class="stat"><span class="k">Funders (in)</span><span class="v">{node['in_degree']}</span></div>
    <div class="stat"><span class="k">Receivers (out)</span><span class="v">{node['out_degree']}</span></div>
    <div class="stat"><span class="k">In / Out</span><span class="v">{node['total_in']:,.0f} / {node['total_out']:,.0f}</span></div>
    <div class="stat"><span class="k">Net flow</span><span class="v {'in' if node['net']>=0 else 'out'}">{node['net']:+,.0f}</span></div>
    <div class="stat"><span class="k">Top receiver share</span><span class="v">{node['top_out_share']*100:.0f}%</span></div>
    <div class="stat"><span class="k">Concentration (Gini)</span><span class="v">{node['gini_in']:.2f} / {node['gini_out']:.2f}</span></div>
  </div>
  <div class="note" style="color:{rolec}">{_esc(node['role_explanation'])}</div>
  <div class="subhead">Inbound funders</div>
  {fund_rows or '<div class="muted">No inbound USDT observed.</div>'}
  <div class="subhead">Outbound receivers</div>
  {recv_rows or '<div class="muted">No outbound USDT observed.</div>'}
</section>""")
        network_blocks = "".join(blocks)

    th = R.get("two_hop") or {}
    if th:
        th_blocks = []
        for chain, info in th.items():
            recv = "".join(
                f'<div class="neigh"><a class="link mono" target="_blank" '
                f'href="{_esc(CHAINS[chain]["etherscan"])}/address/{_esc(r["address"])}">'
                f'{_esc(r["address"][:18])}…</a> <span class="val monster">{r["usdt"]:,.2f} USDT</span></div>'
                for r in info.get("top_receivers", [])[:8])
            th_blocks.append(f"""
<section class="card">
  <div class="chain-head"><h3>2-hop trace — {_esc(CHAINS[chain]['name'])}</h3></div>
  <p>Dominant collector: <a class="link mono" target="_blank"
     href="{_esc(CHAINS[chain]['etherscan'])}/address/{_esc(info['collector'])}">{_esc(info['collector'])}</a></p>
  <div class="stats">
    <div class="stat"><span class="k">Collector out-degree</span><span class="v">{info.get('collector_out_degree','?')}</span></div>
    <div class="stat"><span class="k">Top receiver share</span><span class="v">{info.get('collector_top_receiver_share',0)*100:.0f}%</span></div>
  </div>
  {('<div class="note">⚠ '+_esc(info.get('note'))+'</div>') if info.get('note') else ''}
  <div class="subhead">Funds fan out to</div>
  {recv or '<div class="muted">No 2-hop data.</div>'}
</section>""")
        network_blocks += "".join(th_blocks)

    # --- Resources / links card ---
    def _res_link(label, url):
        return (f'<div class="neigh"><a class="link" target="_blank" '
                f'href="{_esc(url)}">{_esc(label)}</a>'
                f'<span class="muted mono">{_esc(url)}</span></div>')
    res_groups_html = ""
    for group, links in _resources().items():
        items = "".join(_res_link(label, url) for label, url in links)
        res_groups_html += f'<div class="subhead">{_esc(group)}</div>{items}'
    addr_links = "".join(
        _res_link(f"{ch['name']} — view this address",
                  f"{ch['etherscan']}/address/{R['address']}")
        for ch in R["chains"].values())
    resources_html = f"""
<section class="card">
  <div class="chain-head"><h3>Resources &amp; further investigation</h3></div>
  {addr_links}
  {res_groups_html}
</section>"""

    chain_join = "".join(chain_blocks)

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>USDT Wallet Tracer — Risk Report</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;
         background:#0b0f17; color:#e5e7eb; padding:24px; }}
  .wrap {{ max-width:980px; margin:0 auto; }}
  h1 {{ margin:0 0 4px; font-size:22px; }}
  .sub {{ color:#9ca3af; margin-bottom:16px; }}
  .topbar {{ display:flex; align-items:center; gap:16px; flex-wrap:wrap; margin-bottom:20px; }}
  .addr {{ font-family:ui-monospace,Menlo,Consolas,monospace; color:#93c5fd; word-break:break-all; }}
  .risk {{ font-size:26px; font-weight:800; }}
  .card {{ background:#141a26; border:1px solid #1f2937; border-radius:12px; padding:18px; margin-bottom:18px; }}
  .chain-head {{ display:flex; justify-content:space-between; align-items:center; }}
  .chain-head h3 {{ margin:0; }}
  .chaintag {{ font-size:11px; background:#1e293b; padding:2px 8px; border-radius:20px; color:#94a3b8; }}
  .link {{ color:#60a5fa; text-decoration:none; }}
  .link:hover {{ text-decoration:underline; }}
  .stats {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; margin:14px 0; }}
  .stat {{ background:#0f172a; border:1px solid #1f2937; border-radius:8px; padding:8px 10px; }}
  .stat .k {{ display:block; font-size:11px; color:#94a3b8; }}
  .stat .v {{ font-size:15px; font-weight:600; }}
  .in {{ color:#22c55e; }} .out {{ color:#f87171; }} .muted {{ color:#6b7280; }}
  .mono {{ font-family:ui-monospace,Menlo,monospace; font-size:12px; }}
  .note {{ margin:10px 0; color:#fbbf24; }}
  .subhead {{ font-weight:700; margin:14px 0 8px; color:#cbd5e1; text-transform:uppercase; font-size:12px; letter-spacing:.06em; }}
  .flag {{ padding:6px 0; border-bottom:1px dashed #1f2937; }}
  .flag .pill {{ display:inline-block; font-size:11px; padding:1px 8px; border-radius:20px; margin-right:8px; }}
  .flag .ftype {{ font-weight:600; margin-right:8px; }}
  .flag .fdet {{ color:#9ca3af; }}
  .tbl-wrap {{ overflow-x:auto; }}
  table {{ width:100%; border-collapse:collapse; font-size:13px; }}
  th,td {{ text-align:left; padding:6px 8px; border-bottom:1px solid #1f2937; white-space:nowrap; }}
  th {{ color:#94a3b8; }}
  .val {{ font-variant-numeric:tabular-nums; }}
  .role {{ display:inline-block; font-weight:700; padding:2px 10px; border-radius:20px; }}
  .neigh {{ display:flex; gap:6px; align-items:center; padding:3px 0; font-size:12px; }}
  .arrow {{ color:#f87171; }} .arrowin {{ color:#22c55e; }}
  .foot {{ color:#6b7280; font-size:12px; margin-top:8px; }}
  .disclaimer {{ border:1px solid #3f3f46; background:#18181b; color:#fbbf24; padding:10px 12px; border-radius:8px; margin:16px 0; }}
</style></head>
<body><div class="wrap">
  <div class="topbar">
    <div><h1>USDT Wallet Tracer</h1>
      <div class="sub">Public-chain risk report · {_esc(R.get('generated_utc',''))} UTC</div>
    </div>
    <div class="addr">{_esc(R['address'])}</div>
    <div class="risk" style="color:{risk_color}">{risk} <span style="font-size:14px">/ {risk_label}</span></div>
  </div>
  <div class="disclaimer">⚠ {_esc(R.get('disclaimer','Indicators only; not a determination of guilt.'))}</div>
  {chain_join}{network_blocks}{resources_html}
  <div class="foot">Indicators only — pair with full explorer tx review before drawing conclusions.</div>
</div></body></html>"""


def main():
    ap = argparse.ArgumentParser(description="Forward-only multi-chain USDT wallet tracer (public data).")
    ap.add_argument("address", help="Wallet address to trace (0x...)")
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--html", action="store_true")
    ap.add_argument("--output", default=None,
                    help="Write report to this file (implies --html; use .html)")
    ap.add_argument("--chain", action="append", choices=list(CHAINS.keys()),
                    help="Only check given chain (may repeat); default: all")
    ap.add_argument("--apikey", help="Free Etherscan/BscScan API key (improves token history)",
                    default=None)
    ap.add_argument("--map", type=int, default=0, metavar="HOPS",
                    help="Trace N hops outward to map the fund-flow network / detect edge nodes")
    ap.add_argument("--neighbors", type=int, default=25,
                    help="Max immediate neighbors to list in the graph (default 25)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not args.address.startswith("0x") or len(args.address) != 42:
        sys.exit("Invalid address: expected a 0x-prefixed 40-hex address.")

    chains = args.chain if args.chain else list(CHAINS.keys())
    apikey = args.apikey

    # Network mapping needs the real token-transfer history. If the user asks to
    # map and hasn't given a key, prompt securely in the terminal (getpass) so a
    # free Etherscan/BscScan key is never exposed on the command line or to a model.
    if args.map and not apikey:
        print("To map the fund-flow network I need the token TRANSFER history.")
        print("Get a FREE key from https://etherscan.io (ETH) and/or "
              "https://bscscan.com (BSC) -> API-Keys.")
        try:
            import getpass
            apikey = getpass.getpass("Paste one key (works for any chain; hidden input): ").strip()
        except Exception:
            apikey = None
        if not apikey:
            print("No key provided — network map will be empty (balances still work).")

    note = ""
    if not args.quiet and not apikey:
        note = " (no API key — token HISTORY may be limited by public-node restrictions)"
    if not args.quiet:
        print(f"Fetching public on-chain data for {args.address} on {', '.join(chains)}{note} ...")
        time.sleep(0.2)

    report = analyze(args.address, limit=args.limit, quiet=args.quiet,
                     chains=chains, apikey=apikey)
    map_network(report, max_neighbors=args.neighbors)
    if args.map:
        trace_two_hop(report, chains, apikey=apikey,
                      max_neighbors=args.neighbors, max_hops=args.map, quiet=args.quiet)

    if args.html or args.output:
        html = render_html(report)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(html)
            if not args.quiet:
                print(f"Wrote HTML report -> {args.output}")
        else:
            print(html)
    elif args.json:
        print(json.dumps(report, indent=2))
    else:
        render(report)


if __name__ == "__main__":
    main()
