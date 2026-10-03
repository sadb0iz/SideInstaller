# SideInstaller Website — Cloudflare Workers deploy

## Cấu trúc

```
public/                 # Static assets (binding ASSETS)
  index.html
  beta.html
  terms.html
  app-icon.png
  SideInstallerDNS.mobileconfig
  output/               # *.plist (manifest OTA) — IPA vẫn trỏ GitHub
  output-beta/
src/worker.js           # MIME override + routing nhẹ
wrangler.toml
```

## Deploy

```bash
npm i -g wrangler
# đăng nhập
wrangler login
# deploy
wrangler deploy
```

Hoặc dùng Cloudflare Pages: upload thư mục `public/` trực tiếp (không cần worker nếu MIME .plist ổn).

## IPA lớn (~8–9 MB × 50+)

Plist vẫn chứa URL:

`https://raw.githubusercontent.com/FrizzleM/SideInstaller/main/output/....ipa`

→ iOS tải IPA từ GitHub. Không cần upload IPA lên Workers/R2 trừ khi muốn self-host.

Nếu muốn self-host IPA: upload lên R2, sửa từng file `.plist` key `url` thành URL R2 public.

## Lưu ý itms-services

Nút Install dùng JS gắn `window.location.origin` → manifest URL tuyệt đối HTTPS trên domain Workers của bạn. Phải dùng custom domain HTTPS (workers.dev cũng được).

## MIME quan trọng

- `.plist` → `application/xml`
- `.mobileconfig` → `application/x-apple-aspen-config`
