# LinkedIn Egress Runbook

The Greg LinkedIn poster preserves the local SOCKS contract:

```text
socks5://127.0.0.1:1080
```

The active provider is `socks-linkedin-egress.service`, an `autossh -D`
tunnel to the always-on Hetzner VM:

- name: `linkedin-egress`
- Hetzner id: `144756569`
- public IPv4: `5.78.204.57`
- location: `hil` / Hillsboro, OR
- server type: `cpx11`
- tunnel user: `linkedin-egress`

The previous Mac-dependent provider, `socks-mac-tunnel.service`, is disabled.
Do not re-enable it except as an explicit rollback.

## Live Units

```bash
sudo install -m 0644 deploy/socks-linkedin-egress.service /etc/systemd/system/socks-linkedin-egress.service
sudo install -m 0755 deploy/linkedin-egress-health /usr/local/sbin/linkedin-egress-health
sudo install -m 0644 deploy/linkedin-egress-health.service /etc/systemd/system/linkedin-egress-health.service
sudo install -m 0644 deploy/linkedin-egress-health.timer /etc/systemd/system/linkedin-egress-health.timer
sudo systemctl daemon-reload
sudo systemctl disable --now socks-mac-tunnel.service
sudo systemctl enable --now socks-linkedin-egress.service linkedin-egress-health.timer
sudo systemctl restart linkedin-poster@greg.service
```

## Verification

```bash
curl -fsS --socks5-hostname 127.0.0.1:1080 https://api.ipify.org
curl -fsS --socks5-hostname 127.0.0.1:1080 -I https://www.linkedin.com/login/
curl -fsS http://127.0.0.1:3747/health | jq '{ok,browser}'
sudo systemctl start linkedin-egress-health.service
systemctl status linkedin-egress-health.service --no-pager -l
```

Expected:

- SOCKS external IP is `5.78.204.57`.
- LinkedIn `/login/` returns HTTP 200 through SOCKS.
- Poster `/health` returns `ok=true` and `browser.healthy=true`.
- `linkedin-egress-health.service` exits `0/SUCCESS`.
