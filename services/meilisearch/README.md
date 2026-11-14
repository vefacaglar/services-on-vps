# Meilisearch

Uygulamaların ortak kullandığı arama motoru. Sabit sürümlü resmi image (`getmeili/meilisearch:v1.56.2`, digest ile) `production` modunda, telemetri kapalı çalışır. Veri `meilisearch_meili-data` volume'unda (`/meili_data` altında `data.ms`, `dumps`, `snapshots`) tutulur; deploy'lar ve release değişimi veriyi korur.

Mevcut, elle kurulmuş Typesense bu repo tarafından yönetilmez ve olduğu gibi çalışmaya devam eder. Uygulamalar Meilisearch'e geçirilene kadar Typesense'in bakımı ve yedeği elle sürer.

## Uygulamalar nasıl bağlanır

Meilisearch, Caddy ve uygulamalarla ortak Docker ağına (`LOGS_PROXY_NETWORK`, varsayılan `databases_default`) `meilisearch` takma adıyla katılır. Aynı ağdaki uygulamalar şu adresi kullanır:

```text
http://meilisearch:7700
```

Herkese açık port yoktur; Caddy route'u da eklenmez. Uygulamaya master key verme: master key yalnız yönetim içindir. Master key ile `/keys` API'sinden uygulamaya özel anahtar üret; arama yapan servislere `search`, index yazan worker'lara yalnız gereken index'lerle sınırlı `documents.add`/`indexes.*` yetkili anahtar ver:

```sh
curl -X POST http://localhost:7700/keys \
  -H "Authorization: Bearer $MEILI_MASTER_KEY" -H 'Content-Type: application/json' \
  --data '{"description":"site search","actions":["search"],"indexes":["products"],"expiresAt":null}'
```

Anahtarı uygulamanın kendi secret'ı olarak sakla. Master key değişirse ondan türetilmiş anahtarlar da değişir; uygulama secret'larını güncellemek gerekir.

## Yönetim için SSH tüneli

Meilisearch yalnız VPS'in loopback adresinde yayınlanır (`127.0.0.1:7700`). Mac'te:

```sh
ssh -N -L 7700:127.0.0.1:7700 VPS_SSH
curl http://localhost:7700/health
```

`MEILI_HTTP_PORT` değişirse tünelin sağ tarafındaki portu da değiştir. Yönetim isteklerinde `Authorization: Bearer <master key>` başlığı gerekir; anahtarsız istekler `401` döner.

## Master key ve deploy

GitHub'da `Settings → Environments → logs-production → Environment secrets` altında `MEILI_MASTER_KEY` secret'ını ekle. En az 16 byte olmalı, boşluk veya satır sonu içermemeli. Güçlü bir değer üret:

```sh
openssl rand -hex 32 | pbcopy
```

Workflow key'i release içinde mod `600` olan `services/meilisearch/meilisearch.env` dosyasına yazar; log konsolu açıksa aynı key, konsolun salt okunur `Meilisearch` sayfası (index, görev, ayar ve redakte edilmiş anahtar görünümü) için mod `600` olan `services/logs/browser.env` dosyasına da eklenir ve yalnız sunucu tarafında kullanılır; key Compose dosyasına, Git'e, komut argümanlarına veya loglara girmez. Secret yoksa deploy log servisiyle devam eder ve Meilisearch başlatılmaz; secret eklendikten sonraki deploy onu kurar.

`scripts/start.sh` `docker compose up -d --wait` kullanır; ayar değişmediyse çalışan container yeniden başlatılmaz. Ardından `/health` yanıtının `available` olduğunu ve anahtarsız `/indexes` isteğinin `401` döndüğünü doğrular. Doğrulama başarısızsa deploy başarısız sayılır ve önceki release'in başlangıç script'i çalıştırılır. `services/` düzeninden önceki bir release'e dönülürse o release Meilisearch'ü tanımaz; Meilisearch container'ı ve verisi olduğu gibi kalır.

## Kaynak sınırları

| Ayar | Varsayılan | Açıklama |
| --- | --- | --- |
| `MEILI_MEMORY_LIMIT` | `1g` | Container bellek tavanı. |
| `MEILI_CPU_LIMIT` | `1.0` | Container CPU tavanı. |
| `MEILI_MAX_INDEXING_MEMORY` | `512Mb` | Index oluştururken kullanılacak en fazla bellek. Meilisearch bunu container sınırından değil host RAM'inden (2/3'ü) hesaplar; aynı 8 GB sunucudaki Typesense/Postgres'i sıkıştırmamak için açıkça sınırlanır. Değeri `MEILI_MEMORY_LIMIT`in belirgin şekilde altında tut. Biçim: byte, `Mb` veya `Gb` (ör. `768Mb`). |
| `MEILI_MAX_INDEXING_THREADS` | `2` | Index oluşturmada kullanılacak en fazla iş parçacığı. |
| `MEILI_HTTP_PORT` | `7700` | Yalnız loopback yönetim portu. |

Değiştirmek için satırları VPS'teki ortak `/opt/logs-on-vps/.env` dosyasına ekle ve yeniden deploy et (bkz. [.env.example](.env.example)). Container `cap_drop: ALL` ve `no-new-privileges` ile çalışır; index işlemleri veri volume'u dışında geçici dosya yazdığı için kök dosya sistemi salt okunur yapılmaz. Loglar `json-file` rotasyonuyla tutulur ve Vector tarafından otomatik toplanır; log konsolunun `Sistem` sayfası bellek/CPU kullanımını gösterir.

## Yedek

Volume yedeğinin en güvenli yolu Meilisearch'ün kendi dump'ıdır:

```sh
curl -X POST http://localhost:7700/dumps -H "Authorization: Bearer $MEILI_MASTER_KEY"
```

Dump `/meili_data/dumps` altında oluşur; VPS'te `docker compose cp meilisearch:/meili_data/dumps ./meili-dumps` ile alınabilir. Dump'lar sürümler arası taşımaya uygundur; snapshot'lar (`POST /snapshots`, `/meili_data/snapshots`) daha hızlıdır ama aynı sürümle geri yüklenir. Image sürümünü yükseltmeden önce dump al. `docker compose down -v` index verisini siler.

İşletim komutlarını `services/meilisearch` dizininde çalıştır:

```sh
docker compose ps
docker compose logs --tail=100
./scripts/start.sh
```

Resmi kaynaklar: [Yapılandırma](https://www.meilisearch.com/docs/resources/self_hosting/configuration/reference), [API anahtarları](https://www.meilisearch.com/docs/learn/security/basic_security), [dump ve snapshot](https://www.meilisearch.com/docs/learn/data_backup/snapshots_vs_dumps).
