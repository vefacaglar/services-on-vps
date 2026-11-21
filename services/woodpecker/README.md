# Woodpecker CI

Private repo'ları GitHub Actions dakikası harcamadan, VPS'in kendi Docker'ında build ve deploy etmek için kullanılan CI sunucusu. Sabit sürümlü resmi image'lar (`woodpeckerci/woodpecker-server` ve `woodpecker-agent` `v3.20.1`, digest ile) çalışır. Go ile yazılmıştır; boşta sunucu yaklaşık 25 MB, agent yaklaşık 10 MB bellek kullanır. Veri (kullanıcı, repo listesi, pipeline geçmişi, loglar, secret'lar) `woodpecker_woodpecker-data` volume'undaki SQLite dosyasında tutulur; deploy'lar ve release değişimi veriyi korur.

Build'ler iki yerden başlatılır:

- `https://logs.vefacaglar.com/ci`: log konsolunun `CI` sekmesi. Repo ekleme, branch ve ortam seçip build başlatma, adımları ve logları izleme, iptal.
- `https://ci.vefacaglar.com`: Woodpecker'ın kendi arayüzü. Secret'lar, repo ayarları ve ilk GitHub girişi buradan yapılır.

Woodpecker'ın arayüzü [custom.css](custom.css) ile vefacaglar.com ve log konsolunun görünümüne (Fira Code, keskin köşeler, bronz vurgu, açık/koyu tema) uyarlanır. Dosya yalnız Woodpecker'ın kendi tema değişkenlerini ve birkaç genel kuralı değiştirir; yerleşim ve davranış Woodpecker'ındır. [custom.js](custom.js) varsayılan temayı koyu yapar; kullanıcı ayarlarından açık tema yine seçilebilir, yalnız "auto" seçeneği koyuya döner. `scripts/start.sh` iki dosyayı her deploy'da veri volume'una kopyalar; Woodpecker onları her istekte okuduğu için yeniden başlatma gerekmez. Yazı tipi (Fira Code'un Latin ve Türkçe alt kümesi, SIL OFL) dosyanın sonuna gömülüdür.

## Kurulum

Sıra önemlidir: API token'ı ancak Woodpecker bir kez deploy edilip giriş yapıldıktan sonra alınabilir.

1. **DNS:** Cloudflare'de `ci` adında A kaydı oluştur (değer VPS IP'si, `DNS only`). HTTPS sertifikasını mevcut Caddy alır.
2. **GitHub OAuth uygulaması:** GitHub'da `Settings → Developer settings → OAuth Apps → New OAuth App`. `GitHub App` değil, `OAuth App` olmalı.
   - Homepage URL: `https://ci.vefacaglar.com`
   - Authorization callback URL: `https://ci.vefacaglar.com/authorize`
   - Oluşturduktan sonra `Generate a new client secret` ile secret üret.
3. **Secret ve değişkenler:** Bu repo'da `Settings → Environments → logs-production` altında ekle:

   | Ad | Tür | Değer |
   | --- | --- | --- |
   | `WOODPECKER_GITHUB_CLIENT` | secret | OAuth uygulamasının Client ID'si. |
   | `WOODPECKER_GITHUB_SECRET` | secret | OAuth uygulamasının client secret'ı. |
   | `WOODPECKER_AGENT_SECRET` | secret | Sunucu ile agent arasındaki ortak anahtar: `openssl rand -hex 32 \| pbcopy`. |
   | `WOODPECKER_ADMIN` | variable | GitHub kullanıcı adın. Yalnız bu hesap giriş yapabilir (birden fazlaysa virgülle). |
   | `WOODPECKER_DOMAIN` | variable | İsteğe bağlı; varsayılan `ci.vefacaglar.com`. |

4. **Deploy:** `Services CI and deploy → Run workflow`. Üç secret ve `WOODPECKER_ADMIN` birlikte girilmelidir; eksikse deploy hata verir, hiçbiri yoksa Woodpecker atlanır.
5. **İlk giriş ve token:** `https://ci.vefacaglar.com` adresinde GitHub ile giriş yap, sağ üstteki kullanıcı ayarlarında `CLI and API` bölümündeki kişisel token'ı kopyala ve `WOODPECKER_API_TOKEN` adıyla aynı Environment'a **secret** olarak ekle.
6. **Yeniden deploy:** `Run workflow`. Bundan sonra log konsolundaki `CI` sekmesi çalışır. Token yokken sekme "yapılandırılmamış" der, konsolun geri kalanı etkilenmez.

## Bir repo'yu build edilebilir yapmak

`CI` sekmesinde `Repo ekle` ile repo'yu seç. Woodpecker repo'ya bir webhook ekler; kodu GitHub girişindeki yetkinle çeker. Repo'nun kökünde bir `.woodpecker.yml` (veya `.woodpecker/` klasörü) olmalıdır; pipeline tanımı her zaman build edilen branch'teki dosyadan okunur.

Sekmede seçilen ortam pipeline'a `DEPLOY_ENV` değişkeni olarak, ek değişkenler kendi adlarıyla aktarılır. Elle başlatılan build'lerin olayı `manual`'dır. Örnek:

```yaml
when:
  - event: manual

steps:
  - name: test
    image: node:24
    commands:
      - npm ci
      - npm test

  - name: deploy-production
    image: alpine:3.22
    environment:
      SSH_KEY:
        from_secret: production_ssh_key
    commands:
      - ./scripts/deploy.sh production
    when:
      - evaluate: 'DEPLOY_ENV == "production"'

  - name: deploy-staging
    image: alpine:3.22
    environment:
      SSH_KEY:
        from_secret: staging_ssh_key
    commands:
      - ./scripts/deploy.sh staging
    when:
      - evaluate: 'DEPLOY_ENV == "staging"'
```

Secret'lar ortama göre ayrı tutulmaz; `production_...` ve `staging_...` gibi adlarla repo secret'ı olarak Woodpecker arayüzünde (`Repo → Settings → Secrets`) eklenir. Push'ta otomatik build istemiyorsan pipeline'ı yukarıdaki gibi `event: manual` ile sınırla; `when` verilmezse her push da build başlatır.

GitHub Actions workflow'ları Woodpecker'da çalışmaz; her repo için bir kez `.woodpecker.yml` yazmak gerekir. Sözdizimi: [workflow syntax](https://woodpecker-ci.org/docs/usage/workflow-syntax).

## Güvenlik

- **Kimler girebilir:** Kayıt kapalıdır (`WOODPECKER_OPEN=false`); yalnız `WOODPECKER_ADMIN` listesindeki GitHub hesapları giriş yapabilir. Kimlik doğrulama GitHub'dadır, Woodpecker şifre tutmaz.
- **Agent Docker soketine bağlıdır.** Build adımları VPS'in Docker daemon'ında container olarak çalışır. Bir repo'nun pipeline dosyasını değiştirebilen kişi sunucuda kod çalıştırabilir; yalnız kendi repo'larını ekle ve fork PR'larını build etme. Adım container'larına host dizini veya Docker soketi bağlamak, repo Woodpecker'da `trusted` yapılmadıkça reddedilir.
- **Log konsolunun yetkisi dardır.** Konsol Woodpecker'ı sunucu tarafında kişisel token ile çağırır; token tarayıcıya, yanıtlara veya loglara çıkmaz. Yalnız şu işlemler açıktır: repo listeleme/ekleme, branch okuma, build başlatma, sonuç ve log okuma, iptal. Pipeline tanımı, secret veya repo ayarı konsoldan değiştirilemez; build yalnız repo'daki tanımı çalıştırır. Her repo ekleme, build başlatma ve iptal `browser` servisinin loguna yazılır (değişken değerleri yazılmaz).
- **Secret'lar** release içinde mod `600` olan `services/woodpecker/server.env` ve `agent.env` dosyalarına yazılır; Compose dosyasına, Git'e, komut argümanlarına veya loglara girmez. Agent yalnız ortak agent anahtarını alır.
- Sunucu salt okunur kök dosya sistemi, `cap_drop: ALL` ve `no-new-privileges` ile çalışır; HTTP portu yalnız loopback'te (`127.0.0.1:8610`) yayınlanır, dışarıya Caddy üzerinden açılır.

## Kaynak sınırları

| Ayar | Varsayılan | Açıklama |
| --- | --- | --- |
| `WOODPECKER_MAX_WORKFLOWS` | `1` | Aynı anda çalışan build sayısı. 8 GB'lık sunucuda diğer servisleri sıkıştırmamak için tek build. |
| `WOODPECKER_STEP_MEMORY_BYTES` | `2147483648` | Tek bir build adımı container'ının bellek tavanı (byte, 2 GiB). `0` sınırı kaldırır. |
| `WOODPECKER_SERVER_MEMORY_LIMIT` | `256m` | Sunucu container'ının bellek tavanı. |
| `WOODPECKER_AGENT_MEMORY_LIMIT` | `128m` | Agent container'ının bellek tavanı (build adımları buna dahil değildir). |
| `WOODPECKER_HTTP_PORT` | `8610` | Yalnız loopback portu. |

Değiştirmek için satırları VPS'teki ortak `/opt/logs-on-vps/.env` dosyasına ekle ve yeniden deploy et (bkz. [.env.example](.env.example)). Build adımlarının kullandığı image'lar ve build cache'i diskte birikir; agent bunları kendisi temizlemez. Disk dolarsa VPS'te `docker image prune` çalıştır.

## Deploy ve işletim

`scripts/start.sh` `docker compose up -d --wait` kullanır; ayar değişmediyse container'lar yeniden başlatılmaz, süren build kesilmez. Ardından `/healthz` yanıtını ve girişsiz `/api/user` isteğinin `401` döndüğünü doğrular. Sonra deploy, mevcut Caddyfile'a yalnız `ci` domain'inin route'unu ekler ([browser rehberindeki](../../docs/browser-access.md) aynı yedekli ve geri alınabilir yöntemle). Doğrulama başarısızsa deploy başarısız sayılır ve önceki release başlatılır; Woodpecker'ı tanımayan eski bir release'e dönülürse container'lar ve veri olduğu gibi kalır.

Yedek için SQLite dosyasını kopyala:

```sh
cd /opt/logs-on-vps/current/services/woodpecker
docker compose cp server:/var/lib/woodpecker/woodpecker.sqlite ./woodpecker-backup.sqlite
```

İşletim komutları aynı dizinde:

```sh
docker compose ps
docker compose logs --tail=100
./scripts/start.sh
```

`docker compose down -v` repo listesini, pipeline geçmişini ve secret'ları siler.

Resmi kaynaklar: [sunucu ayarları](https://woodpecker-ci.org/docs/administration/configuration/server), [GitHub bağlantısı](https://woodpecker-ci.org/docs/administration/configuration/forges/github), [Docker backend](https://woodpecker-ci.org/docs/administration/configuration/backends/docker), [ortam değişkenleri](https://woodpecker-ci.org/docs/usage/environment).
