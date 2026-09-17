# Network posture, and how to reach the box after it (17 Sep 2026)

Until today every service on this VM listened on `0.0.0.0` with no firewall: `ufw` was
inactive and the `iptables` INPUT policy was `ACCEPT` with zero rules. The engine API
(`:4000`), the dashboard (`:3000`) and the Lynk webhook receiver (`:8645`) were readable
by anyone who could route to the host.

**What that actually cost, stated precisely, because the wrong description leads to the
wrong fix.** Every route on `:4000` is a `GET` (`app.get` only — there is no `post`,
`put`, `delete` or `patch` anywhere in `dist/api/server.js`) and there is no auth
middleware. So the exposure was **information disclosure, not a remote kill switch**: the
wallet address, the equity, the open positions, their bin ranges and the model's
reasoning log. Control has never been on this surface — it is Telegram and
`data/engine_control.json`. That is not a reason to leave it open: a wallet address
beside a live position size and range is enough to find the position on-chain and trade
against it.

## What is in place now

| | before | now |
|---|---|---|
| engine API `:4000` | `0.0.0.0` | `127.0.0.1` |
| dashboard `:3000` | `0.0.0.0` | `127.0.0.1` |
| Lynk webhook `:8645` | `0.0.0.0` | unchanged — fronted by `cloudflared`, and `ufw` now blocks direct inbound |
| `ufw` | inactive | active: deny incoming, allow outgoing, allow `22/tcp` |

`ufw` is enabled on system startup, so it survives a reboot.

### The bind lives in two places, and only one of them survives a rebuild

- `src/api/server.ts` — the source of truth. **Change this one.**
- `dist/api/server.js` — what pm2 actually runs. Edited in the same commit because the
  box runs the compiled output and does not rebuild on deploy.

`npm run build` regenerates `dist/` **from `src/`**, so the source change is what keeps
this from silently reverting. The `dist/` edit is a compilation artefact: it exists only
so the running process picked the change up without a rebuild. If you ever see them
disagree, `src/` is right.

The dashboard binds through `dashboard/package.json`:
`"start": "next start -H 127.0.0.1"`.

### Why binding `:4000` broke nothing

The dashboard never calls `:4000` from the browser. `dashboard/next.config.mjs` rewrites
`/:path*` to `http://127.0.0.1:4000/api/:path*` **server-side**, and
`dashboard/.env.local` has `NEXT_PUBLIC_API_URL=` (empty), so the client bundle ships
relative paths. Verified rather than assumed, on 17 Sep 2026:

```
$ grep -roh "http://localhost:4000\|http://127.0.0.1:4000" dashboard/.next/static/
(no output)
$ curl -sf http://127.0.0.1:3000/overview | head -c 60
{"cohort":{"id":"all","label":"All-Time Archive",...
```

If anyone ever sets `NEXT_PUBLIC_API_URL` to an absolute URL, that is the moment this
stops being true and the dashboard starts calling the port from the browser.

## Reaching the dashboard now

**SSH port-forward.** Nothing to install, nothing new exposed:

```bash
ssh -L 3000:127.0.0.1:3000 -L 4000:127.0.0.1:4000 ubuntu@<VM-IP>
```

Leave it running and open <http://127.0.0.1:3000> in the browser on your own machine.
`-L 4000:...` is only needed to hit the raw API directly; the dashboard proxies it
anyway.

A named shortcut, in `~/.ssh/config` on your laptop:

```
Host fm
    HostName <VM-IP>
    User ubuntu
    IdentityFile ~/.ssh/<key>
    LocalForward 3000 127.0.0.1:3000
    LocalForward 4000 127.0.0.1:4000
```

then just `ssh fm`.

**From a phone: use a cloudflared route, never a port.** `cloudflared` already runs here
for the Lynk webhook, as a quick tunnel:

```
/usr/local/bin/cloudflared tunnel --url http://localhost:8645 --no-autoupdate
```

A quick tunnel gets a **new random hostname every restart**, which is fine for a webhook
whose URL is re-registered and wrong for a dashboard you want to bookmark. Adding the
dashboard properly means a NAMED tunnel with two ingress rules and Cloudflare Access in
front of it — the dashboard has no auth of its own, so a tunnel without Access simply
moves the same open page to a nicer address.

**This is a decision for a human and has not been made.** Reopening `:3000` to the world
is not the alternative — it is the thing that was just closed.

## Checks

```bash
sudo ufw status verbose                       # active, deny incoming, 22/tcp allowed
ss -tlnp | grep -E ':3000|:4000'              # both on 127.0.0.1
curl -sf http://127.0.0.1:4000/api/health     # 200 from the box
curl -sf http://<VM-IP>:4000/api/health       # must FAIL from anywhere else
```

Measured from outside on 17 Sep 2026 after the change: `:3000`, `:4000` and `:8645` all
refuse; `:22` accepts.

## If you lock yourself out

`ufw` was enabled behind a self-cancelling failsafe, and the same trick is the safe way
to change these rules again:

```bash
sudo systemd-run --unit=ufw-failsafe --on-active=5min /usr/sbin/ufw --force disable
# ... make the change, then verify a BRAND-NEW ssh session still connects ...
sudo systemctl stop ufw-failsafe.timer        # only once you are certain
```

Verifying with the session you are already inside proves nothing: `ufw` accepts
`RELATED,ESTABLISHED` in `before.rules`, so an existing connection survives rules that
would refuse every new one. **Open a second terminal and connect fresh.**

If you are already locked out, the provider's serial/VNC console is the way back in;
`ufw disable` from there restores the previous posture.

## Not covered here

- **The provider's own security group is not visible from inside the VM.** `ufw` is a
  second layer, not the only one, and nothing in this document says what the cloud
  firewall allows. Check it in the provider console.
- **`:8645` still listens on `0.0.0.0`.** Only `ufw` stops direct inbound to it. It was
  left alone deliberately: it is the Lynk receiver, outside this change's scope, and
  `cloudflared` reaches it over loopback either way. Binding it to `127.0.0.1` would be
  strictly better and is a separate, small change.


## Dashboard is stopped on purpose (17 Sep 2026)

`pm2 stop flowmetrix-dashboard` + `pm2 save`, at the operator's request: he reads history on
Meteora/Jupiter directly, and this process was the least stable thing on the box (52 restarts,
a Next.js server-action error). Nothing else depends on `:3000` — the engine API, the cron jobs
and the Lynk webhook talk to `:4000`, `:8645` and the DB directly.

Stated so a later session does not read it as a crash:

- `:3000` not listening is **expected**, not a failure.
- `flowmetrix_analytics_refresh.sh` no longer restarts it — it restarts only when the process is
  already online, so the 4-hourly job cannot revive it by accident. The regenerated
  `analytics.html` is still copied into `dashboard/public/` and is served the moment a human
  starts the process again.
- Restore: `pm2 start flowmetrix-dashboard && pm2 save`.
- `pm2 save` ran while it was stopped. `pm2 resurrect` after a reboot may still start what is in
  the dump; if that matters, check `pm2 list` after a reboot and stop it again.
- The loopback bind in `dashboard/package.json` (`next start -H 127.0.0.1`) stays, so it comes
  back loopback-only.
