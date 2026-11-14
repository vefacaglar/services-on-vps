# VPS ortak servisleri

Bu repo VPS'teki uygulamaların ortak kullandığı sunucu altyapısını tutar. Her servis kendi dizininde, kendi Compose projesiyle çalışır; hepsi aynı GitHub Actions akışıyla doğrulanıp tek release olarak deploy edilir. Uygulamaların kendi kodu ve Compose dosyaları kendi repo'larında kalır.

## Servisler

| Servis | Dizin | Ne yapar |
| --- | --- | --- |
| Loglar | [services/logs](services/logs/README.md) | VictoriaLogs + Vector ile tüm container loglarını toplar; `logs.vefacaglar.com` üzerinde şifreli log konsolu ve `Sistem` sayfası (bellek, CPU, disk) salt okunur Meilisearch inceleyicisi ve onaylı yazma modlu PostgreSQL inceleyicisi ([PostgreSQL kurulumu](docs/postgres-inspector.md)). |
| Meilisearch | [services/meilisearch](services/meilisearch/README.md) | Uygulamaların ortak arama motoru; ortak Docker ağında `http://meilisearch:7700`. |

Typesense şimdilik elle kurulu kalır ve bu repo tarafından yönetilmez; uygulamalar Meilisearch'e taşınınca kaldırılacak.

## Dizinler

```text
services/<servis>/   compose.yml, .env.example, README.md, scripts/start.sh ve servise özel dosyalar
scripts/             ortak deploy script'leri ve tüm servisleri başlatan scripts/start.sh
docs/                GitHub deploy ve log arayüzü rehberleri
tests/               deploy, Caddy ve container entegrasyon testleri
```

## Deploy

`main`e gelen her değişiklik [GitHub Actions](.github/workflows/logs.yml) ile test edilir: React client ve Go konsolu testleri, deploy script testleri, gerçek Docker log toplama ve browser testleri, geçici anahtarla Meilisearch sağlık/anahtar kontrolü. Sonra `scripts/ssh-deploy.sh` yalnız izinli dosyaları ve secret'lardan üretilen mod `600` dosyaları VPS'te `releases/<id>/` altına yükler; `scripts/activate.sh` ortak `.env` dosyasını her servise bağlar, `scripts/start.sh` ile servisleri sırayla başlatıp doğrular ve başarılıysa `current` symlink'ini yeni release'e çevirir. Başarısızlıkta önceki release'in `scripts/start.sh`'ı çalıştırılır.

Kurulum, secret'lar ve VPS hazırlığı: [GitHub deploy rehberi](docs/github-deploy.md). Log arayüzü ve Caddy: [browser rehberi](docs/browser-access.md).

Yeni bir servis eklerken `services/<ad>/` altında kendi `name:` değerli `compose.yml`'ını ve doğrulayan `scripts/start.sh`'ını oluştur, `scripts/start.sh`, `scripts/ssh-deploy.sh` bundle listesi ve workflow'a ekle.

Yerel kontroller:

```sh
(cd services/logs/client && npm ci && npm test && npm run build)
(cd services/logs/console && go test -race ./...)
python3 -m unittest discover -s tests -p 'test_*.py'
```
