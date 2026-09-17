#!/usr/bin/env python3
"""Ukur koncesi swap live DARI CHAIN (baca-saja) — nambah sampel selain 5 baris exit_economics.

Sumber: signature yang tersimpan di DB (live_execution_attempts.swap_signature,
simulated_positions.sweep_signature/close_signature/swap_signature). Harga ideal = harga pool
yang dicatat engine saat keputusan (entry_price / exit_price / pool_price_at_exit).

Koncesi entry (SOL->token):  (hargaDapat - hargaIdeal)/hargaIdeal   (dapat lebih sedikit = mahal)
Koncesi exit  (token->SOL):  (hargaIdeal - hargaDapat)/hargaIdeal   (dapat SOL lebih sedikit = rugi)

Read-only: cuma `getTransaction`. Tidak menandatangani, tidak mengirim, tidak menulis DB.
"""
import json, os, re, sqlite3, sys, time, urllib.request

REPO = '/home/ubuntu/flowmetrix-ai-agent'
OUT = '/home/ubuntu/.hermes/scripts/diag/out/swap_concession.json'


def env_val(key):
    for line in open(f'{REPO}/.env'):
        m = re.match(rf'^{key}=(.*)$', line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return None


RPC = env_val('SOLANA_RPC_URL')
WALLET = env_val('SOLANA_WALLET_ADDRESS')
DB = env_val('DATABASE_PATH') or 'data/flowmetrix.db'
if not DB.startswith('/'):
    DB = f'{REPO}/{DB}'
if not RPC:
    sys.exit('SOLANA_RPC_URL tidak ada di .env')


def rpc(method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={'Content-Type': 'application/json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                d = json.load(r)
            if 'error' in d:
                raise RuntimeError(str(d['error'])[:200])
            return d['result']
        except Exception as e:                                   # 429 / timeout -> backoff
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def deltas(tx, mint):
    """(sol_delta_human, token_delta_human) milik wallet kita di dalam satu tx."""
    meta, msg = tx['meta'], tx['transaction']['message']
    keys = msg['accountKeys'] if isinstance(msg.get('accountKeys'), list) else msg['accountKeys']
    idx = [i for i, k in enumerate(keys)
           if (k['pubkey'] if isinstance(k, dict) else k) == WALLET]
    if not idx:
        return None, None
    i = idx[0]
    sol = (meta['postBalances'][i] - meta['preBalances'][i] + meta['fee']) / 1e9
    tok = 0.0
    pre = sum(float(b['uiTokenAmount']['uiAmountString']) for b in (meta.get('preTokenBalances') or [])
              if b.get('mint') == mint and b.get('owner') == WALLET)
    post = sum(float(b['uiTokenAmount']['uiAmountString']) for b in (meta.get('postTokenBalances') or [])
               if b.get('mint') == mint and b.get('owner') == WALLET)
    tok = post - pre
    return sol, tok


def measure(sig, mint, ideal_price, leg):
    tx = rpc('getTransaction', [sig, {'encoding': 'jsonParsed', 'maxSupportedTransactionVersion': 0,
                                      'commitment': 'confirmed'}])
    if not tx:
        return {'sig': sig, 'err': 'tx tidak ketemu'}
    sol, tok = deltas(tx, mint)
    if sol is None:
        return {'sig': sig, 'err': 'wallet tidak ada di tx'}
    row = {'sig': sig, 'sol_delta': round(sol, 6), 'tok_delta': round(tok, 2),
           'ideal_price_sol_per_token': ideal_price, 'fee_sol': tx['meta']['fee'] / 1e9,
           'slot': tx.get('slot'), 'blockTime': tx.get('blockTime'), 'err_onchain': bool(tx['meta'].get('err'))}
    if leg == 'entry' and tok > 0 and sol < 0:
        got = -sol / tok
        row['achieved_price'] = got
        row['concession_bps'] = round((got - ideal_price) / ideal_price * 1e4, 1) if ideal_price else None
    elif leg == 'exit' and tok < 0 and sol > 0:
        got = sol / -tok
        row['achieved_price'] = got
        row['concession_bps'] = round((ideal_price - got) / ideal_price * 1e4, 1) if ideal_price else None
    else:
        row['concession_bps'] = None
        row['note'] = 'arah leg tidak sesuai (masuk/keluar tidak match)'
    return row


con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
con.row_factory = sqlite3.Row

cases = []
# --- leg ENTRY: attempt yang benar-benar membuka posisi (punya entry_price) ---
for r in con.execute("""select a.id attempt_id, a.pair_name, a.token_mint, a.swap_signature,
                               p.entry_price, p.position_address
                        from live_execution_attempts a
                        left join simulated_positions p on p.position_address = a.position_address
                        where a.swap_signature is not null order by a.attempted_at"""):
    cases.append(dict(leg='entry', label=f"attempt#{r['attempt_id']} {r['pair_name']}",
                      sig=r['swap_signature'], mint=r['token_mint'], ideal=r['entry_price']))
# --- leg EXIT: sweep terjual (punya harga pool saat exit) ---
for r in con.execute("""select e.pair_name, e.mint, p.sweep_signature, e.pool_price_at_exit, e.position_id
                        from exit_economics e join simulated_positions p on p.position_id = e.position_id
                        where p.sweep_signature is not null"""):
    cases.append(dict(leg='exit', label=f"exit {r['pair_name']} {str(r['position_id'])[:8]}",
                      sig=r['sweep_signature'], mint=r['mint'], ideal=r['pool_price_at_exit']))
# --- leg EXIT tambahan: unwind gagal-open (attempt-10 LEVERCAT dsb) dari DB attempts tanpa entry_price ---
for r in con.execute("""select a.id attempt_id, a.pair_name, a.token_mint, a.rescue_signature, a.swap_signature
                        from live_execution_attempts a where a.outcome='failed'"""):
    cases.append(dict(leg='exit', label=f"failed-open unwind attempt#{r['attempt_id']} {r['pair_name']}",
                      sig=r['rescue_signature'] or r['swap_signature'], mint=r['token_mint'], ideal=None))

print(f'# wallet={WALLET[:5]}… ({len(cases)} kandidat)  ideal-price dari DB\n')
rows = []
for c in cases:
    try:
        m = measure(c['sig'], c['mint'], c['ideal'], c['leg'])
    except Exception as e:
        m = {'sig': c['sig'], 'err': f'{type(e).__name__}: {e}'[:140]}
    m.update(label=c['label'], leg=c['leg'])
    rows.append(m)
    conc = m.get('concession_bps')
    print(f"{c['label']:38} {c['leg']:5} sol={m.get('sol_delta')} tok={m.get('tok_delta')} "
          f"ideal={c['ideal']} conc={conc} bps {m.get('err') or m.get('note') or ''}")
    time.sleep(0.4)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({'measuredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'wallet': WALLET[:5] + '…', 'source': 'on-chain getTransaction (read-only)',
           'rows': rows}, open(OUT, 'w'), indent=1)
print(f'\n-> {OUT}')

good = [r for r in rows if r.get('concession_bps') is not None]
for leg in ('entry', 'exit'):
    xs = sorted(r['concession_bps'] for r in good if r['leg'] == leg)
    if xs:
        med = xs[len(xs) // 2] if len(xs) % 2 else (xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2
        print(f"{leg}: n={len(xs)} min={xs[0]} med={med} max={xs[-1]} bps  (mean {sum(xs)/len(xs):.1f})")
