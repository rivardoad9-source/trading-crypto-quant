# Evidence pack — FlowMetrix engine audit (server-side)
Generated: **2026-09-10 23:02:58 WIB** | read-only, deterministic | machine: this server
HEAD: `362711e` — `362711e docs(prompts): standalone audit prompt (paste-ready) — engine audit`
Repo clean: 1 modified file(s)

## 1. ENV SHADOWING — `.env` vs proses pm2 yg beneran jalan
- var di `.env`: **57** · var di proses pm2: **130**
- **SHADOWED (beda nilai `.env` vs proses → `.env` TIDAK berlaku): 1**
  - `DEEPSEEK_API_KEY`: .env=`<masked>` | proses=`<masked>`
- var `.env` yang TIDAK sampai ke proses: 55
  - `ANTIRUG_ENABLED` = `true`
  - `ANTIRUG_MAX_TOP10_HOLDER_PCT` = `25`
  - `ANTIRUG_ON_ERROR` = `reject`
  - `ANTIRUG_REQUIRE_FREEZE_REVOKED` = `true`
  - `ANTIRUG_REQUIRE_MINT_REVOKED` = `true`
  - `DATABASE_PATH` = `./data/flowmetrix.db`
  - `DEEPSEEK_BASE_URL` = `https://api.deepseek.com`
  - `DEEPSEEK_MODEL_CHAT` = `deepseek-chat`
  - `DEEPSEEK_MODEL_REASONER` = `deepseek-reasoner`
  - `DRY_RUN` = `false`
  - `ENGINE_CONTROL_FILE` = `/home/ubuntu/flowmetrix-ai-agent/data/engine_control.json`
  - `FORCED_EXIT_SLIPPAGE_PCT` = `2.0`
  - `FRED_API_KEY` = `<empty>`
  - `GMGN_API_KEY` = `<masked>`
  - `GMGN_GATE_MODE` = `report`
  - `GMGN_MAX_BAD_CONCENTRATION_PCT` = `15`
  - `LIVE_CAPITAL_SOL` = `3.05`
  - `LIVE_MAX_POSITION_BINS` = `1400`
  - `LIVE_MAX_POSITION_SOL` = `1.8`
  - `LIVE_MICRO_CAPITAL` = `true`
  - `MAX_CONCURRENT_POSITIONS` = `3`
  - `MAX_FEE_ACCRUAL_GAP_HOURS` = `1`
  - `MAX_FEE_TVL_RATIO` = `0.25`
  - `MAX_POSITION_AGE_HOURS` = `24`
  - `MAX_PRICE_CHANGE_24H_PCT` = `150`
  - `MAX_PRICE_SURGE_1H_PCT` = `10`
  - `MAX_REALIZED_VOL_PCT_PER_HOUR` = `20`
  - `MAX_TVL_USD` = `500000`
  - `METEORA_API_URL` = `https://dlmm.datapi.meteora.ag`
  - `MIN_24H_VOLUME_USD` = `10000`
  - `MIN_DOWNSIDE_COVER_PCT` = `45`
  - `MIN_FEE_COST_COVERAGE` = `2.5`
  - `MIN_FEE_TVL_RATIO` = `0.008`
  - `MIN_POOL_AGE_HOURS` = `48`
  - `MIN_TVL_USD` = `50000`
  - `MIN_UPSIDE_COVER_PCT` = `15`
  - `NODE_ENV` = `development`
  - `ONCHAIN_EXECUTION_ARMED` = `true`
  - `ONCHAIN_MAX_LAMPORTS_PER_TX` = `2900000000`
  - `POOL_DENYLIST` = `zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX,STONK-SOL,9abbXL7rTz1GHitpJz7qdbcYNe8ATeXUW1po5RfMvT2t,OTC-SOL,2UScGf5LCQpSR6AShiLU6G6tPTDcZomjB8CKuNg7eeTF`
  - `PORT` = `4000`
  - `POST_MORTEM_ENABLED` = `true`
  - `PRIORITY_FEE_COMPUTE_UNITS` = `200000`
  - `PRIORITY_FEE_PERCENTILE` = `75`
  - `SOLANA_PRIVATE_KEY` = `<masked>`
  - `SOLANA_RPC_URL` = `<masked>`
  - `SOLANA_WALLET_ADDRESS` = `FaVHg7bThap7wcF9G7kjSjrDsMbVrgUkpG6twzi1yQKi`
  - `STARTING_BALANCE_USD` = `298.02`
  - `STOP_LOSS_PCT` = `-8.0`
  - `TAKE_PROFIT_PCT` = `5.0`
  - `TELEGRAM_ALLOWED_USER_IDS` = `6678941282`
  - `TELEGRAM_CHAT_ID` = `6678941282`
  - `TZ` = `Asia/Jakarta`
  - `VIRTUAL_SOL_PER_POSITION` = `1.0`
  - `VOLATILITY_ON_UNKNOWN` = `reject`
- **LEAKED (ada di proses, ga ada di `.env` → bocor dari shell sesi pembuat pm2): 115**
  - `AI_AGENT` = `hermes-agent`
  - `BROWSERBASE_ADVANCED_STEALTH` = `false`
  - `BROWSERBASE_PROXIES` = `true`
  - `BROWSER_INACTIVITY_TIMEOUT` = `120`
  - `BROWSER_SESSION_TIMEOUT` = `300`
  - `BUFFER_ACCESS_TOKEN` = `<masked>`
  - `DBUS_SESSION_BUS_ADDRESS` = `unix:path=/run/user/1000/bus`
  - `GOPROXY` = `https://mirrors.tencent.com/go,direct`
  - `HERMES_AGENT` = `true`
  - `HERMES_CRON_SESSION` = ``
  - `HERMES_CUSTOM_AI_SUMOPOD_COM_API_KEY` = `<masked>`
  - `HERMES_CUSTOM_LOCALHOST_20128_API_KEY` = `<masked>`
  - `HERMES_CUSTOM_RKWTGA3_ABC_TUNNEL_US_API_KEY` = `<masked>`
  - `HERMES_DEEPSEEK_API_KEY` = `<masked>`
  - `HERMES_EXEC_ASK` = `1`
  - `HERMES_GATEWAY_BUSY_INPUT_MODE` = `interrupt`
  - `HERMES_HOME` = `/home/ubuntu/.hermes`
  - `HERMES_INTERACTIVE` = `1`
  - `HERMES_KANBAN_BOARD` = `default`
  - `HERMES_MAX_ITERATIONS` = `150`
  - `HERMES_MEDIA_DELIVERY_STRICT` = `0`
  - `HERMES_MEDIA_TRUST_RECENT_FILES` = `1`
  - `HERMES_QUIET` = `1`
  - `HERMES_REAL_HOME` = `/home/ubuntu`
  - `HERMES_SESSION_CHAT_ID` = `6678941282`
  - `HERMES_SESSION_CHAT_NAME` = `Zemiz .`
  - `HERMES_SESSION_CHAT_TYPE` = `dm`
  - `HERMES_SESSION_ID` = ``
  - `HERMES_SESSION_KEY` = `<masked>`
  - `HERMES_SESSION_MESSAGE_ID` = `4151`
  - `HERMES_SESSION_PLATFORM` = `telegram`
  - `HERMES_SESSION_PROFILE` = ``
  - `HERMES_SESSION_SCOPE_ID` = ``
  - `HERMES_SESSION_SOURCE` = ``
  - `HERMES_SESSION_THREAD_ID` = ``
  - `HERMES_SESSION_USER_ID` = `6678941282`
  - `HERMES_SESSION_USER_ID_ALT` = ``
  - `HERMES_SESSION_USER_NAME` = `Zemiz .`
  - `HERMES_TURN_LEASE_TIMEOUT` = `1800`
  - `HERMES_UI_SESSION_ID` = ``
  - `IMAGE_TOOLS_DEBUG` = `false`
  - `INVOCATION_ID` = `47f2d03b71fe42d2b77e6a54429cccb2`
  - `JOURNAL_STREAM` = `8:9255503`
  - `LESSCLOSE` = `/usr/bin/lesspipe %s %s`
  - `LESSOPEN` = `| /usr/bin/lesspipe %s`
  - `LS_COLORS` = `rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35:do=01;35:bd=40;33;01:cd=40;33;01:or=40;31;01:mi=00:su=37;41:sg=30;43:ca=00:tw=30;42:ow=34;42:st=37;44:ex=01;32:*.tar=01;31:*.tgz=01;31:*.arc=01;31:*.arj=01;31:*.taz=01;31:*.lha=01;31:*.lz4=01;31:*.lzh=01;31:*.lzma=01;31:*.tlz=01;31:*.txz=01;31:*.tzo=01;31:*.t7z=01;31:*.zip=01;31:*.z=01;31:*.dz=01;31:*.gz=01;31:*.lrz=01;31:*.lz=01;31:*.lzo=01;31:*.xz=01;31:*.zst=01;31:*.tzst=01;31:*.bz2=01;31:*.bz=01;31:*.tbz=01;31:*.tbz2=01;31:*.tz=01;31:*.deb=01;31:*.rpm=01;31:*.jar=01;31:*.war=01;31:*.ear=01;31:*.sar=01;31:*.rar=01;31:*.alz=01;31:*.ace=01;31:*.zoo=01;31:*.cpio=01;31:*.7z=01;31:*.rz=01;31:*.cab=01;31:*.wim=01;31:*.swm=01;31:*.dwm=01;31:*.esd=01;31:*.avif=01;35:*.jpg=01;35:*.jpeg=01;35:*.mjpg=01;35:*.mjpeg=01;35:*.gif=01;35:*.bmp=01;35:*.pbm=01;35:*.pgm=01;35:*.ppm=01;35:*.tga=01;35:*.xbm=01;35:*.xpm=01;35:*.tif=01;35:*.tiff=01;35:*.png=01;35:*.svg=01;35:*.svgz=01;35:*.mng=01;35:*.pcx=01;35:*.mov=01;35:*.mpg=01;35:*.mpeg=01;35:*.m2v=01;35:*.mkv=01;35:*.webm=01;35:*.webp=01;35:*.ogm=01;35:*.mp4=01;35:*.m4v=01;35:*.mp4v=01;35:*.vob=01;35:*.qt=01;35:*.nuv=01;35:*.wmv=01;35:*.asf=01;35:*.rm=01;35:*.rmvb=01;35:*.flc=01;35:*.avi=01;35:*.fli=01;35:*.flv=01;35:*.gl=01;35:*.dl=01;35:*.xcf=01;35:*.xwd=01;35:*.yuv=01;35:*.cgm=01;35:*.emf=01;35:*.ogv=01;35:*.ogx=01;35:*.aac=00;36:*.au=00;36:*.flac=00;36:*.m4a=00;36:*.mid=00;36:*.midi=00;36:*.mka=00;36:*.mp3=00;36:*.mpc=00;36:*.ogg=00;36:*.ra=00;36:*.wav=00;36:*.oga=00;36:*.opus=00;36:*.spx=00;36:*.xspf=00;36:*~=00;90:*#=00;90:*.bak=00;90:*.crdownload=00;90:*.dpkg-dist=00;90:*.dpkg-new=00;90:*.dpkg-old=00;90:*.dpkg-tmp=00;90:*.old=00;90:*.orig=00;90:*.part=00;90:*.rej=00;90:*.rpmnew=00;90:*.rpmorig=00;90:*.rpmsave=00;90:*.swp=00;90:*.tmp=00;90:*.ucf-dist=00;90:*.ucf-new=00;90:*.ucf-old=00;90:`
  - `MEMORY_PRESSURE_WATCH` = `/sys/fs/cgroup/system.slice/hermes-gateway.service/memory.pressure`
  - `MEMORY_PRESSURE_WRITE` = `c29tZSAyMDAwMDAgMjAwMDAwMAA=`
  - `MOA_TOOLS_DEBUG` = `false`
  - `NVM_BIN` = `/home/ubuntu/.nvm/versions/node/v22.23.2/bin`
  - `NVM_CD_FLAGS` = ``
  - `NVM_DIR` = `/home/ubuntu/.nvm`
  - `NVM_INC` = `/home/ubuntu/.nvm/versions/node/v22.23.2/include/node`
  - `OBSIDIAN_VAULT_PATH` = `/home/ubuntu/obsidian-vault`
  - `OLDPWD` = `/home/ubuntu/flowmetrix-ai-agent`
  - `PROMPT_COMMAND` = `history -a; `
  - `SSH_CLIENT` = `103.121.168.210 14942 22`
  - `SSH_CONNECTION` = `103.121.168.210 14942 10.11.19.130 22`
  - `SSH_TTY` = `/dev/pts/0`
  - `SSL_CERT_FILE` = `/home/ubuntu/.hermes/hermes-agent/venv/lib/python3.11/site-packages/certifi/cacert.pem`
  - `SYSTEMD_EXEC_PID` = `1644531`
  - `TELEGRAM_ALLOWED_USERS` = `6678941282`
  - `TERMINAL_CONTAINER_CPU` = `1`
  - `TERMINAL_CONTAINER_DISK` = `51200`
  - `TERMINAL_CONTAINER_MEMORY` = `5120`
  - `TERMINAL_CONTAINER_PERSISTENT` = `True`
  - `TERMINAL_CWD` = `/home/ubuntu`
  - `TERMINAL_DAYTONA_IMAGE` = `nikolaik/python-nodejs:python3.11-nodejs20`
  - `TERMINAL_DEGRADED_MODE` = `warn`
  - `TERMINAL_DOCKER_ENV` = `{}`
  - `TERMINAL_DOCKER_EXTRA_ARGS` = `[]`
  - `TERMINAL_DOCKER_FORWARD_ENV` = `[]`
  - `TERMINAL_DOCKER_IMAGE` = `nikolaik/python-nodejs:python3.11-nodejs20`
  - `TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE` = `False`
  - `TERMINAL_DOCKER_NETWORK` = `True`
  - `TERMINAL_DOCKER_RUN_AS_HOST_USER` = `False`
  - `TERMINAL_DOCKER_SHM_SIZE` = `1g`
  - `TERMINAL_DOCKER_VOLUMES` = `[]`
  - `TERMINAL_ENV` = `local`
  - `TERMINAL_HOME_MODE` = `auto`
  - `TERMINAL_LIFETIME_SECONDS` = `300`
  - `TERMINAL_MODAL_IMAGE` = `nikolaik/python-nodejs:python3.11-nodejs20`
  - `TERMINAL_MODAL_MODE` = `auto`
  - `TERMINAL_PERSISTENT_SHELL` = `True`
  - `TERMINAL_SINGULARITY_IMAGE` = `docker://nikolaik/python-nodejs:python3.11-nodejs20`
  - `TERMINAL_TIMEOUT` = `60`
  - `TERMINAL_VERCEL_RUNTIME` = `node24`
  - `THREADS_API_TOKEN` = `<masked>`
  - `VISION_TOOLS_DEBUG` = `false`
  - `WEB_TOOLS_DEBUG` = `false`
  - `XDG_DATA_DIRS` = `/usr/local/share:/usr/share:/var/lib/snapd/desktop`
  - `XDG_RUNTIME_DIR` = `/run/user/1000`
  - `XDG_SESSION_CLASS` = `user`
  - `XDG_SESSION_ID` = `13625`
  - `XDG_SESSION_TYPE` = `tty`
  - `_HERMES_GATEWAY` = `1`
  - `_config_version` = `38`
  - `cwd` = `/home/ubuntu/flowmetrix-ai-agent`
  - `exec_interpreter` = `/home/ubuntu/.nvm/versions/node/v22.23.2/bin/node`
  - `exec_mode` = `fork_mode`
  - `group_sessions_per_user` = `True`
  - `instance_var` = `NODE_APP_INSTANCE`
  - `km_link` = `false`
  - `name` = `flowmetrix-engine`
  - `namespace` = `default`
  - `node_version` = `22.23.2`
  - `pm_cwd` = `/home/ubuntu/flowmetrix-ai-agent`
  - `pm_err_log_path` = `/home/ubuntu/.pm2/logs/flowmetrix-engine-error.log`
  - `pm_exec_path` = `/home/ubuntu/flowmetrix-ai-agent/dist/index.js`
  - `pm_out_log_path` = `/home/ubuntu/.pm2/logs/flowmetrix-engine-out.log`
  - `pm_pid_path` = `/home/ubuntu/.pm2/pids/flowmetrix-engine-5.pid`
  - `status` = `online`
  - `unique_id` = `27858ac1-a4f7-43bb-8e5e-68b2af849253`
  - `username` = `ubuntu`
  - `version` = `0.1.0`

## 2. DATABASE — `./data/flowmetrix.db`
- tabel (6): `daily_pnl_snapshots`, `daily_research_logs`, `pool_execution_failures`, `scan_funnel_cycles`, `simulated_positions`, `sqlite_sequence`
  - `daily_pnl_snapshots`: 4 baris
  - `daily_research_logs`: 7 baris
  - `pool_execution_failures`: 6 baris
  - `scan_funnel_cycles`: 271 baris
  - `simulated_positions`: 0 baris
  - `sqlite_sequence`: 4 baris

### 2a. Money-path rows

**`simulated_positions`** (20 terbaru):

```
<0 baris>
```

**`pool_execution_failures`** (20 terbaru):

```
pool_address | pair_name | consecutive_failures | last_failure_at | last_stage | last_reason | total_failures | last_success_at | token_mint
------------------------------------------------------------------------------------------------------------------------
95NyuWzMDmWnPgLGBotT1XB2v1fQkqxhCrGLBDfxXfhn | KNOTS-SOL | 1 | 2026-09-09 19:32:10 | open | the swap confirmed but no token balance could be read | 1 |  | 
nBXytBBfKLhj6teXarAv8rk6WNgUFBMyybUFRkuK7ad | KNOTS-SOL | 1 | 2026-09-09 19:02:49 | open | [onchain/dlmm] openPosition on position ENNpRNx6aotJH4hFtT7N | 1 |  | 
Ekm4LYkihEdQgZx2UReDMJ3eCDDjExPQLG94WfWmfyWr | OTC-SOL | 1 | 2026-09-09 13:32:24 | open | [onchain/dlmm] openPosition on position DX2JQn7muPZtWNdBGwzA | 1 |  | 
3WY9N19nTtPSqrbWTeaFn2HfJ9MfdyLRSrRvy97GnDgY | TripleT-SOL | 0 |  |  |  | 0 | 2026-09-09 12:27:55 | 
GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8 | ZCAT-SOL | 1 | 2026-09-08 01:03:29 | open | [onchain/dlmm] openPosition on position 8F7p1xnXo4VYy5YuW79t | 1 |  | 
6xBKq4zHKwe4u19CZfm6cyqBoFojsc1yUNB8dZMHbqb | SOLCAT-SOL | 1 | 2026-09-07 16:33:55 | open | [onchain/dlmm] openPosition on position FY1cgRUrT9dRpviqK7wJ | 1 |  | 
```

**`scan_funnel_cycles`** (20 terbaru):

```
id | cycle_at | scanned | screen_rejections | candidates | cooldown_rejected | antirug_passed | antirug_rejected | volatility_rejected | coverage_rejected | micro_rejected | reached_decision | opened | skip_reason | positions_checked | positions_closed | duration_ms | execution_rejected | screener_candidates | held_excluded | exec_denylist_rejected | exec_breaker_rejected | exec_bincap_rejected | exec_no_wsol_rejected | exec_token_bench_rejected
------------------------------------------------------------------------------------------------------------------------
271 | 2026-09-10 16:00:09 | 600 | {"blacklisted":0,"unverifiedToken":157,"lowTvl":271,"lowVolu | 18 | 0 | 3 | 3 | 0 | 3 | 0 | 0 | 0 | no candidate clears the breakeven gate (2.5x round-trip cost | 0 | 0 | 9454 | 18 | 36 | 0 | 3 | 2 | 0 | 13 | 0
270 | 2026-09-10 15:30:10 | 600 | {"blacklisted":0,"unverifiedToken":156,"lowTvl":273,"lowVolu | 17 | 0 | 3 | 3 | 0 | 3 | 0 | 0 | 0 | no candidate clears the breakeven gate (2.5x round-trip cost | 0 | 0 | 9749 | 18 | 35 | 0 | 3 | 2 | 0 | 13 | 0
269 | 2026-09-10 15:00:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 0 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
268 | 2026-09-10 14:40:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
267 | 2026-09-10 14:35:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
266 | 2026-09-10 14:30:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 0 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
265 | 2026-09-10 14:25:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 0 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
264 | 2026-09-10 14:20:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
263 | 2026-09-10 14:15:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
262 | 2026-09-10 14:10:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
261 | 2026-09-10 14:05:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 0 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
260 | 2026-09-10 14:00:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
259 | 2026-09-10 13:55:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 0 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
258 | 2026-09-10 13:50:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
257 | 2026-09-10 13:45:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
256 | 2026-09-10 13:40:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
255 | 2026-09-10 13:35:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
254 | 2026-09-10 13:30:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual pause op | 0 | 0 | 1 | 0 |  | 0 | 0 | 0 | 0 | 0 | 0
253 | 2026-09-10 13:25:00 |  | {} | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | engine paused via the operator control file (manual
```

### 2b. Sinyal integritas
- integrity_check: {'integrity_check': 'ok'}
- kolom `pool_execution_failures`: ['pool_address', 'pair_name', 'consecutive_failures', 'last_failure_at', 'last_stage', 'last_reason', 'total_failures', 'last_success_at', 'token_mint']
- row dgn `token_mint` NULL/kosong: {'c': 6}
- group per pool_address: {'c': 6}
- kolom `simulated_positions`: ['id', 'position_id', 'pool_address', 'pair_name', 'strategy_type', 'entry_price', 'lower_bin_price', 'upper_bin_price', 'virtual_sol_amount', 'entry_tvl', 'entry_24h_volume', 'status', 'unclaimed_fee_usd', 'realized_pnl_usd', 'realized_pnl_pct', 'opened_at', 'closed_at', 'exit_price', 'reasoning_log', 'confidence_score', 'last_checked_at', 'current_price', 'impermanent_loss_usd', 'floating_pnl_usd', 'entry_sol_price_usd', 'close_reason', 'top10_holder_pct', 'mint_authority_revoked', 'freeze_authority_revoked', 'safety_verdict', 'est_gas_cost_usd', 'est_priority_micro_lamports', 'post_mortem', 'post_mortem_at', 'position_value_change_usd', 'breakeven_coverage_ratio', 'expected_fee_24h_usd', 'execution_mode', 'position_address', 'open_signature', 'close_signature', 'swap_signature', 'deposited_sol_lamports', 'deposited_paired_amount', 'rent_paid_lamports', 'wallet_lamports_before', 'wallet_lamports_after']
- `simulated_positions` group by `status`: []
- `simulated_positions` group by `closed_at`: []
- `simulated_positions` group by `pool_address`: []

## 3. LOG pm2
- `flowmetrix-engine-out.log`: 0.6 MB · `flowmetrix-engine-error.log`: 1.3 MB

**frekuensi tag log:**
```
2397 [dlmm]
    616 [preflight]
    286 [cron]
    271 [funnel]
    207 [telegram]
    111 [main]
    111 [db]
     76 [live]
     73 [api]
     43 [postmortem]
     39 [reconcile]
     31 [control]
```

### 3a. Pola kegagalan sepanjang umur log (bukan cuma hari ini)
- `orphan`: out=0 err=0
- `half-landed`: out=0 err=0
- `partially funded`: out=0 err=0
- `recover`: out=2 err=0
- `unwind`: out=7 err=14
- `bench`: out=1 err=236
- `strike`: out=0 err=0
- `409`: out=3 err=176
- `bot launch failed`: out=0 err=142
- `ERROR`: out=39 err=368
- `RPC`: out=0 err=6
- `rate limit`: out=0 err=0
- `max_tokens`: out=0 err=56
- `timeout`: out=0 err=36
- `rejected`: out=1150 err=5580

### 3b. 40 baris terakhir yang mengandung error/warn/orphan
```
Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo failed: exceeded CUs meter at BPF instruction. Signatures that DID land: 5XnxxTtsHPJ3Qh8rUVViXoK4tK5pvCc7EvQsH6FBDyJogA8QMVynJkzRR3hEGnxt9R1FNyeAFadtojdjBZzLJWGS. CHECK THE POSITION ON-CHAIN BEFORE RETRYING — re-running will repeat the parts that already succeeded.)
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 28, cooldown-rejected 0, exec-guard-rejected 2, safe 0, rug-rejected 6, vol-rejected 0, cost-rejected 0, opened no (all 6 candidates failed the anti-rug screen)
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 7, cooldown-rejected 0, exec-guard-rejected 28, safe 4, rug-rejected 2, vol-rejected 0, cost-rejected 2, opened no (live execution failed: [live] pool 9abbXL7rTz1GHitpJz7qdbcYNe8ATeXUW1po5RfMvT2t has no wSOL side; the engine sizes in SOL and cannot fund this pair)
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 8, cooldown-rejected 0, exec-guard-rejected 28, safe 3, rug-rejected 3, vol-rejected 0, cost-rejected 2, opened no (live execution failed: [live] pool 9abbXL7rTz1GHitpJz7qdbcYNe8ATeXUW1po5RfMvT2t has no wSOL side; the engine sizes in SOL and cannot fund this pair)
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 8, cooldown-rejected 0, exec-guard-rejected 28, safe 4, rug-rejected 2, vol-rejected 1, cost-rejected 1, opened no (live execution failed: [live] pool 9abbXL7rTz1GHitpJz7qdbcYNe8ATeXUW1po5RfMvT2t has no wSOL side; the engine sizes in SOL and cannot fund this pair)
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 21, cooldown-rejected 0, exec-guard-rejected 19, safe 4, rug-rejected 2, vol-rejected 3, cost-rejected 0, opened no (all candidates failed the volatility gates (3 rejected))
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 23, cooldown-rejected 0, exec-guard-rejected 19, safe 4, rug-rejected 2, vol-rejected 2, cost-rejected 0, opened no (live execution failed: [live] the balancing swap CONFIRMED but the position open failed. The wallet now holds 3885908112 base units of MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump that nothing monitors (swap 5fZPQF94StH8KT9fMth1HfU5NBj8Zf96BniprZNLpWJ2jWURqFPxPFzwhCsGy7jP4SQGesWXBneycjGFtax3Sprk). Auto-unwind back to SOL submitted (4V4HSCLzk4AoMrfMsFj7YCJHt9cZYemV94eDDHE4vE9BaJTpJJnmbYGrwdbgaEVSmRMu3rfaymwQd355VhmS1xUP). Cause: [onchain/dlmm] openPosition on position DX2JQn7muPZtWNdBGwzA1YuVmi9C2yogKNQ2WGbqj8QZ landed 1 of its transactions and then failed: [onchain] dlmm openPosition (fund wide position) 1/2: rejected at preflight, so it never reached the network and nothing is in flight: Simulation failed. 
Message: Transaction simulation failed: Error processing Instruction 6: custom program error: 0x1774. 
  "Program log: AnchorError thrown in programs/lb_clmm/src/instructions/rebalance/rebalance_params.rs:75. Error Code: ExceededBinSlippageTolerance. Error Number: 6004. Error Message: Exceeded bin slippage tolerance.",
  "Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo failed: custom program error: 0x1774"
Catch the `SendTransactionError` and call `getLogs()` on it for full details.
    Program log: AnchorError thrown in programs/lb_clmm/src/instructions/rebalance/rebalance_params.rs:75. Error Code: ExceededBinSlippageTolerance. Error Number: 6004. Error Message: Exceeded bin slippage tolerance.
    Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo failed: custom program error: 0x1774. Signatures that DID land: 5aVKwpZfCHyNUaqUs26xmk4jsfjpFq9X5whuMrYdLGoeBXNeZha6AWNjEEX36Ci2AzUoTmG2UjjAv5Djf7m8bgyb. CHECK THE POSITION ON-CHAIN BEFORE RETRYING — re-running will repeat the parts that already succeeded.)
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 21, cooldown-rejected 0, exec-guard-rejected 20, safe 4, rug-rejected 2, vol-rejected 2, cost-rejected 0, opened no (live execution failed: [onchain] jupiter swap: rejected at preflight, so it never reached the network and nothing is in flight: Simulation failed. 
Me
```

### 3c. 25 baris terakhir (konteks terkini)
```
[dlmm] post-news fast cadence: PPI closed 1h 15m ago — ticking every 5m instead of 30m, for 90m after the window
[dlmm] cycle start
[control] entries held: file (manual pause operator: pre-news (PPI 10 Sep 19:30 WIB)); telegram: running
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 0, cooldown-rejected 0, exec-guard-rejected 0, safe 0, rug-rejected 0, vol-rejected 0, cost-rejected 0, opened no (engine paused via the operator control file (manual pause operator: pre-news (PPI 10 Sep 19:30 WIB)) — new entries skipped, monitoring continues)
[funnel] scanned n/a -> screened 0 -> held -0 -> cooldown -0 -> exec-guard -0 -> candidates 0 -> antirug 0/-0 -> vol -0 -> coverage -0 -> micro -0 -> none | 0ms
[dlmm] post-news fast cadence: PPI closed 1h 20m ago — ticking every 5m instead of 30m, for 90m after the window
[dlmm] cycle start
[control] entries held: file (manual pause operator: pre-news (PPI 10 Sep 19:30 WIB)); telegram: running
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 0, cooldown-rejected 0, exec-guard-rejected 0, safe 0, rug-rejected 0, vol-rejected 0, cost-rejected 0, opened no (engine paused via the operator control file (manual pause operator: pre-news (PPI 10 Sep 19:30 WIB)) — new entries skipped, monitoring continues)
[funnel] scanned n/a -> screened 0 -> held -0 -> cooldown -0 -> exec-guard -0 -> candidates 0 -> antirug 0/-0 -> vol -0 -> coverage -0 -> micro -0 -> none | 1ms
[dlmm] post-news fast cadence: PPI closed 1h 25m ago — ticking every 5m instead of 30m, for 90m after the window
[dlmm] cycle start
[control] entries held: file (manual pause operator: pre-news (PPI 10 Sep 19:30 WIB)); telegram: running
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 0, cooldown-rejected 0, exec-guard-rejected 0, safe 0, rug-rejected 0, vol-rejected 0, cost-rejected 0, opened no (engine paused via the operator control file (manual pause operator: pre-news (PPI 10 Sep 19:30 WIB)) — new entries skipped, monitoring continues)
[funnel] scanned n/a -> screened 0 -> held -0 -> cooldown -0 -> exec-guard -0 -> candidates 0 -> antirug 0/-0 -> vol -0 -> coverage -0 -> micro -0 -> none | 1ms
[dlmm] cycle start
[control] entries held: file (manual pause operator: pre-news (PPI 10 Sep 19:30 WIB)); telegram: running
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 0, cooldown-rejected 0, exec-guard-rejected 0, safe 0, rug-rejected 0, vol-rejected 0, cost-rejected 0, opened no (engine paused via the operator control file (manual pause operator: pre-news (PPI 10 Sep 19:30 WIB)) — new entries skipped, monitoring continues)
[funnel] scanned n/a -> screened 0 -> held -0 -> cooldown -0 -> exec-guard -0 -> candidates 0 -> antirug 0/-0 -> vol -0 -> coverage -0 -> micro -0 -> none | 0ms
[dlmm] cycle start
[dlmm] cycle done — checked 0, closed 0, stale 0, candidates 17, cooldown-rejected 0, exec-guard-rejected 18, safe 3, rug-rejected 3, vol-rejected 0, cost-rejected 3, opened no (no candidate clears the breakeven ga
```

### 3d. error.log 30 baris terakhir
```
[antirug] rejected MET-SOL (FAIL): top 10 holders control 80.0% (limit 25%)
[antirug] rejected TOAD-SOL (FAIL): top 10 holders control 31.9% (limit 25%)
[friction] rejected fone-SOL: 24h fee $7.4678 covers round-trip cost $4.3868 only 1.70x (need 2.5x)
[friction] rejected CATE-SOL: 24h fee $5.9307 covers round-trip cost $4.3868 only 1.35x (need 2.5x)
[friction] rejected CATE-SOL: 24h fee $6.4732 covers round-trip cost $4.3868 only 1.48x (need 2.5x)
[guard] skipped OTC-SOL: on the operator POOL_DENYLIST
[guard] skipped KNOTS-SOL: 1 on-chain execution failure AFTER the balancing swap spent (one is enough to bench); last at the open stage: [onchain/dlmm] openPosition on position ENNpRNx6aotJH4hFtT7NMB6TdeAUm9QWBGX9pYUBkDLZ landed 2 of its transactions and then failed: [onchain/dlmm] openPosition (fund wide position) on position ENNpRNx6aotJH4hFtT7NMB6TdeAUm9QWBGX9pYUBkDLZ landed 1 of its transactions and then failed: [onchain] dlmm openPosition (fund wide position) 2/2: rejected at preflight, so it never reached the network and nothing is in flight: Simulation failed. 
Message: Transaction simulation failed: Error processing Instr; benched for another 3.0h of 24h
[guard] skipped ANTHROPIC-USDC: pool has no wSOL side (ANTHROPIC / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped STONK-SOL: on the operator POOL_DENYLIST
[guard] skipped STONK-USDC: pool has no wSOL side (STONK / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped xBTC-USDC: pool has no wSOL side (xBTC / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped STONK-SOL: on the operator POOL_DENYLIST
[guard] skipped STONK-USDC: pool has no wSOL side (STONK / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped NEURALINK-USDC: pool has no wSOL side (NEURALINK / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped xSOL-USDC: pool has no wSOL side (xSOL / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped OPENAI-USDC: pool has no wSOL side (OPENAI / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped KNOTS-SOL: 1 on-chain execution failure AFTER the balancing swap spent (one is enough to bench); last at the open stage: the swap confirmed but no token balance could be read; benched for another 3.5h of 24h
[guard] skipped ANDURIL-USDC: pool has no wSOL side (ANDURIL / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped SV151-USDC: pool has no wSOL side (SV151 / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped GP-USDC: pool has no wSOL side (GP / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped ZCAT-USDC: pool has no wSOL side (ZCAT / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped USELESS-USDC: pool has no wSOL side (USELESS / USDC); the engine funds in SOL and cannot open this pair
[guard] skipped POLYMARKET-USDC: pool has no wSOL side (POLYMARKET / USDC); t
```

## 4. File kontrol & gate (state saat ini)
- `data/engine_control.json` TIDAK ADA
- `data/news_blackout.json` ada · umur 421.6 menit · 1281 B

```
{
  "generated_at": "2026-09-10T09:00:40.533841+00:00",
  "generated_at_wib": "Thu 10 Sep 2026 16:00 WIB",
  "lead_min": 60,
  "tail_min": 45,
  "windows": [
    {
      "event": "PPI",
      "label": "PPI",
      "release_utc": "2026-09-10T12:30:00+00:00",
      "start_utc": "2026-09-10T11:30:00+00:00",
      "end_utc": "2026-09-10T13:15:00+00:00",
      "release_wib": "Thu 10 Sep 2026 19:30 WIB",
      "start_wib": "Thu 10 Sep 2026 18:30 WIB",
      "end_wib": "Thu 10 Sep 2026 20:15 WIB",
      "source": "calendar"
    },
    {
      "event": "CPI",
      "label": "CPI",
      "release_utc": "2026-09-11T12:30:00+00:00",
      "start_utc": "2026-09-11T11:30:00+00:00",
      "end_utc": "2026-09-11T13:15:00+00:00",
      "release_wib": "Fri 11 Sep 2026 19:30 WIB",
      "start_wib": "Fri 11 Sep 2026 18:30 WIB",
      "end_wib": "Fri 11 Sep 2026 20:15 WIB",
      "source": "calendar"
    },
    {
      "event": "FOMC",
      "label": "FOMC",
      "release_utc": "2026-09-16T18:00:00+00:00",
      "start_utc": "2026-09-16T17:00:00+00:00",
      "end_utc": "2026-09-16T18:45:00+00:00",
      "release_wib": "Thu 17 Sep 2026 01:00 WIB",
      "start_wib": "Thu 17 Sep 2026 00:00 WIB",
      "end_wib": "Thu 17 Sep 2026 01:45 WIB",
      "source": "calendar"
    }
  ]
}

```
- `data/news_calendar.json` TIDAK ADA

- file `data/*.json` yg ada: ['news_blackout.json']
- writer blackout: /home/ubuntu/.hermes/scripts/news_blackout_write.py
- file terkait blackout di workspace Hermes: ['news_blackout_refresh.sh', 'news_blackout_write.py']

## 5. Rantai (read-only RPC)
- RPC: `<masked>`
- wallet `FaVHg7bThap7wcF9G7kjSjrDsMbVrgUkpG6twzi1yQKi`: 2.944854 SOL
- token accounts (non-SOL) di wallet: **1** ← kandidat ORPHAN kalau > 0
  - mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` amount=1.062727

## 6. Git — 12 commit terakhir + file yg disentuh
```
362711e docs(prompts): standalone audit prompt (paste-ready) — engine audit
73ebbd8 docs(incident): 409 RESOLVED — leaked process-env token shadowed .env (not an external poller); refresh full-audit brief for b6ed678
b6ed678 chore: export trading data (0 trades)
c8240de fix(engine): post-news log line said 'running every 90m for 90m'
e497880 tune(engine): post-news fast window 120 -> 90 minutes
e16eb61 feat(engine): 5-minute screener tick with a bounded post-news fast window
bef9654 docs(incident): engine command bot cannot hold a getUpdates session (unresolved) + raw-HTTP bridge mitigation
8aa3379 feat(engine): bot launch retries + file-based pause control + bench hardening
289099f fix(news): bound blackout window length + sanitise operator-file labels
ad81cef docs(incident): correct KNOTS finding (bench is per-pool -> token-level repeat loss) + full-audit brief
5144390 docs(incident): settle the 02:32 second-attempt question (on-chain blockTimes + DB) + Claude handoff prompt
e930184 docs(incident): bot self-heal + file-control brief, news-blackout gate brief, macro research tradfi gap (10 Sep 2026)
```
```
362711e docs(prompts): standalone audit prompt (paste-ready) — engine audit
docs/prompts/audit-engine-2026-09-10.txt

73ebbd8 docs(incident): 409 RESOLVED — leaked process-env token shadowed .env (not an external poller); refresh full-audit brief for b6ed678
docs/incidents/2026-09-10-bot-409-process-env-token-RESOLVED.md
docs/incidents/2026-09-10-bot-poll-conflict-unresolved.md
docs/incidents/2026-09-10-full-audit-brief.md

b6ed678 chore: export trading data (0 trades)
exports/daily_pnl.csv
exports/research_logs.json
exports/summary.json

c8240de fix(engine): post-news log line said 'running every 90m for 90m'
src/services/screenerCadence.ts
src/tests/screenerCadence.test.ts

e497880 tune(engine): post-news fast window 120 -> 90 minutes
src/config/constants.ts
src/tests/v11Baseline.test.ts

e16eb61 feat(engine): 5-minute screener tick with a bounded post-news fast window
src/config/constants.ts
src/index.ts
src/services/deepseek.ts
src/services/screenerCadence.ts
src/tests/deepseekBudget.test.ts
src/tests/screenerCadence.test.ts
src/tests/v11Baseline.test.ts

bef9654 docs(incident): engine command bot cannot hold a getUpdates session (unresolved) + raw-HTTP bridge mitigation
docs/incidents/2026-09-10-bot-poll-conflict-unresolved.md

8aa3379 feat(engine): bot launch retries + file-based pause control + bench hardening
.env.example
dashboard/src/components/ScanFunnel.tsx
dashboard/src/lib/api.ts
src/agents/dlmmTraderAgent.ts
src/config/env.ts
src/database/db.ts
src/database/repositories.ts
src/database/schema.sql
src/services/engineControl.ts
src/services/executionGuard.ts
src/services/liveExecution.ts
src/services/marketData.ts
src/services/overview.ts
src/services/telegramCommands.ts
src/tests/engineControl.test.ts
src/tests/executionGuard.test.ts
src/tests/funnel.test.ts
src/tests/telegramLaunch.test.ts

289099f fix(news): bound blackout window length + sanitise operator-file labels
src/services/newsBlackout.ts
src/tests/newsBlackout.test.ts

ad81cef docs(incident): correct KNOTS finding (bench is per-pool -> token-level repeat loss) + full-audit brief
docs/incidents/2026-09-10-claude-handoff-prompt.md
docs/incidents/2026-09-10-full-audit-brief.md
docs/incidents/2026-09-10-half-landed-open-unmonitored-position.md

5144390 docs(incident): settle the 02:32 second-attempt question (on-chain blockTimes + DB) + Claude handoff prompt
docs/incidents/2026-09-10-claude-handoff-prompt.md
docs/incidents/2026-09-10-half-landed-open-unmonitored-position.md

e930184 docs(incident): bot self-heal + file-control brief, news-blackout gate brief, macro research tradfi gap (10 Sep 2026)
docs/incidents/2026-09-10-bot-selfheal-and-file-control-brief.md
docs/incidents/2026-09-10-macro-research-blind-tradfi.md
docs/incidents/2026-09-10-news-blackout-gate-brief.md
```

- unpushed: 0

## 7. Test baseline
- Di server ini test terakhir: **729 total / 722 pass / 7 fail** — 7 failure = assertion bahwa profil LIVE
  inert (didokumentasikan, bukan regresi). Sumber: run 10 Sep 2026 pasca-deploy cadence.
- jumlah file test: 34
- skrip test di package.json:
```
"scripts": {
    "build": "tsc -p tsconfig.json && node src/scripts/copyAssets.mjs",
    "dev": "node --import tsx --watch src/index.ts",
    "start": "node dist/index.js",
    "api": "node --import tsx src/api/server.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.scripts.json",
    "research:once": "node --import tsx src/scripts/runResearcher.ts",
    "dlmm:once": "node --import tsx src/scripts/runDlmmCycle.ts",
    "snapshot:once": "node --import tsx src/scripts/runSnapshot.ts",
    "db:reset": "node --import tsx src/scripts/resetDb.ts",
    "dashboard:dev": "npm --prefix dashboard run dev",
    "dashboard:build": "npm --prefix dashboard run build",
```
