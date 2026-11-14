# VPS log merkezi

VictoriaLogs logları saklar; Vector aynı Docker daemon'ındaki container'ların stdout/stderr loglarını otomatik toplar. Mevcut authserver-go, vefacaglar-site API ve worker Compose dosyaları `json-file` kullandığından uygulama koduna veya Docker network'lerine ekleme gerekmez. Yeni container'lar ve blue/green sürümler otomatik keşfedilir.

Bu servis repo'nun `services/logs/` dizinindedir: `compose.yml` (Compose proje adı `logs-on-vps`; volume ve container adları bu yüzden değişmez), `vector/`, Go log konsolu `console/`, React client `client/`, browser/Caddy dosyaları `deploy/` ve servis script'leri `scripts/`. Repo genelindeki diğer servisler için [ana README](../../README.md)'ye bak.

GitHub üzerinden otomatik deploy için [Environment, secret ve VPS hazırlık rehberi](../../docs/github-deploy.md) hazır. Aşağıdaki rsync kurulumu manuel alternatiftir.

## VPS'e gönderme

Mac'te, `VPS_SSH` yerine mevcut SSH alias'ını veya `kullanici@sunucu` adresini yaz:

```sh
cd /Users/vefa/Projects/logs-on-vps
rsync -av --exclude='.git' --exclude='.env' ./ VPS_SSH:~/logs-on-vps/
```

VPS'te Docker Engine, Compose v2+ ve `curl` gerekir. Docker komutlarını çalıştırabilen kullanıcıyla:

```sh
cd ~/logs-on-vps/services/logs
cp -n .env.example .env
./scripts/start.sh
```

Script sabit sürümlü image'ları çeker, Vector ayarlarını ve JSON dönüşümlerini doğrular, servisleri başlatır, gerçek bir geçici Docker container'ından yazılan logları sorgular. Probe container'ı test sonunda silinir. Sonraki güncellemelerde dosyaları tekrar gönderip aynı script'i çalıştır; `.env` ve veri volume'ları korunur. Yeni ayarları uygulamak için her çalıştırmada iki servis de yeniden oluşturulur; kısa bir log toplama aralığı oluşabilir.

## Arayüz

Sunucuya bağlanmadan `https://logs.vefacaglar.com` üzerinden kullanıcı adı ve şifreyle erişim için [GitHub secrets ve HTTPS kurulumunu](../../docs/browser-access.md) uygula.

Domain tamamen bize ait React + TypeScript client'ı açar: Türkçe/İngilizce, açık/koyu tema, sayfa içi giriş, servis/seviye/zaman filtreleri ve geçmiş kayıtlar. `Gelişmiş sorgu` aynı sekmede kendi LogsQL çalışma alanımızı açar; CodeMirror, grafik, gruplama, tablo/JSON, canlı akış ve export içerir. `Alanları incele` log alanları ve değerlerini gösterir. VictoriaLogs yalnız sorgu/depolama API'sidir; native arayüzü domain üzerinden yayınlanmaz. Mevcut kullanıcı adı/şifre secret'ları geçerlidir; Docker client ve Go binary'sini otomatik derler.

`Sistem` sayfası sunucudaki toplam RAM'i ve hangi uygulamanın ne kadar bellek ve CPU kullandığını gösterir; 5 saniyede bir yenilenir. Container'lar ve host systemd servisleri (`docker`, `containerd`, `ssh` gibi) ayrı listelenir. Uygulama belleği `docker stats` gibi geri kazanılabilir dosya önbelleğini saymaz; CPU tek çekirdeğin yüzdesidir. Bunun için browser container'ına host'un `/sys/fs/cgroup` ağacı salt okunur bağlanır (`deploy/compose.browser.yml`); Docker socket'i verilmez. Container adları loglardan (`container_id` → `container_name`, son 7 gün) okunur, hiç log yazmamış container'lar kısa id'leriyle görünür. Linux cgroup v2 yoksa (ör. yerelde macOS) yalnız toplam bellek gösterilir. Disk bölümü container içindeki `/` için `statfs` okur: overlay kök dosya sistemi `/var/lib/docker`'ın bulunduğu diski (normalde VPS'in kök diski) raporlar, ek mount gerekmez; Docker verisi ayrı bir diskteyse o disk görünür. Kullanılabilir alan `df` gibi root için ayrılan blokları saymaz. Log verisi boyutu VictoriaLogs'un `/metrics` çıktısındaki `vl_data_size_bytes` serilerinin toplamıdır; sunucu tarafında iç ağdan okunur, `/metrics` domain üzerinden yayınlanmaz.

`Meilisearch` sayfası ortak Meilisearch'ü salt okunur gösterir: sürüm, durum, veritabanı boyutu, index listesi, başarısız veya süren görevler, index swap geçmişi, index bazında belge arama/filtreleme (tablo veya JSON), ayarlar ve alan dağılımı, görevler ve API anahtarları. Tarayıcı Meilisearch'e hiç bağlanmaz; konsol yalnız izinli `/api/meili/*` uçlarını oturum ve aynı-köken kontrolüyle sunar ve Meilisearch'ü sunucu tarafında `MEILISEARCH_URL` (varsayılan `http://meilisearch:7700`, ortak proxy ağı) üzerinden master key ile çağırır. Genel proxy yoktur, yazma işlemi yapılmaz. Anahtarlar yalnız ilk 8 karakterleriyle döner; master key hiçbir yanıtta, hata mesajında veya logda görünmez. Deploy, `MEILI_MASTER_KEY` secret'ı varsa onu mod `600` olan `browser.env` dosyasına da ekler; secret yoksa sayfa "yapılandırılmamış" der, log konsolu etkilenmez. Meilisearch'te index alias'ı yoktur; sayfa bunun yerine `indexSwap` görevlerini (yeniden adlandırmalar dahil) listeler.

`PostgreSQL` bölümü sunucudaki (bu repo tarafından yönetilmeyen) PostgreSQL'i gösterir: genel durum ve uzun süren sorgular, veritabanları, tablo boyutları ve istatistikleri, kolon/index/kısıt/tetikleyici ayrıntıları, tablo satırları ve SQL çalışma alanı (nesne gezgini, sekmeler, tamamlama, biçimlendirme, `EXPLAIN` planı, sonuç ızgarası, CSV/JSON indirme). Bağlantı yalnız `POSTGRES_URL` secret'ından gelir (eski ad `POSTGRES_READONLY_URL` yedek). Okumalar kendi kısa ömürlü bağlantısında `BEGIN READ ONLY` + zaman aşımlarıyla çalışır ve geri alınır; en fazla 3 bağlantı açılır, sonuçlar sınırlanır ve DSN hiçbir yanıtta görünmez. Varsayılan kapalı **yazma modu** ifadeleri önizleyip (çalıştır + geri al) onayla commit eder, tablo satırlarını birincil anahtarla düzenler ve her commit'i loga yazar; `POSTGRES_WRITE_ENABLED=false` environment variable'ı ile kapatılır. Superuser ile bağlanılırsa arayüz uyarı gösterir. Rol SQL'i ve kurulum: [docs/postgres-inspector.md](../../docs/postgres-inspector.md).

Mac'te ayrı terminalde tüneli açık tut:

```sh
ssh -N -L 9428:127.0.0.1:9428 VPS_SSH
```

Tünel yalnız yerel yönetim/API erişimi içindir. `curl http://localhost:9428/select/logsql/query -d 'query=_time:1h' -d 'limit=10'` ile doğrudan sorgu çalıştırılabilir. `LOG_HTTP_PORT` değişirse tünelin sağ tarafındaki portu da değiştir. Günlük arayüz için domain üzerindeki React client'ı kullan.

## Uygulamalar

Uygulamalar normal logger'larıyla stdout/stderr'e yazmaya devam eder. JSON loglarda `msg` veya `message` metin olarak, uygulamanın diğer alanları `app.*` altında saklanır. Pino sayısal seviyeleri ve slog seviyeleri `level` alanında normalize edilir. Container kimliği ve Compose etiketleri uygulama JSON'u tarafından değiştirilemez. Düz metin logları da toplanır.

Arayüzde örnek sorgular:

```text
_time:1h compose_service:authserver
_time:1h compose_service:api
_time:1h compose_service:worker level:error
_time:1h app.request_id:="req-42"
```

Yalnız dosyaya yazılan loglar, host systemd servisleri ve başka makinelerdeki uygulamalar bu kurulumun kapsamına girmez. Caddy/Postgres container'ları stdout/stderr'e yazıyorsa onlar da toplanır. VictoriaLogs ve Vector kendi loglarını döngü oluşturmamak için toplamaz; bunlara `docker compose logs` ile bakılır. Mevcut Typesense log aktarımı varsa bu kurulum onu kapatmaz.

## Kaynaklar ve işletim

`.env` isteğe bağlıdır. Varsayılan saklama süresi 14 gün, VictoriaLogs bellek tavanı 768 MiB, Vector bellek tavanı 256 MiB'dir; iş yüküne göre ayarlanabilir. `LOG_DISK_BUDGET=10GiB` eski günlük bölümleri sildiren yumuşak eşiktir, kesin disk kotası değildir: en az son iki gün tutulur ve eşik aşılabilir. Diskte boş alan bırak. Vector gönderilemeyen loglar için kalıcı volume'da 512 MiB kuyruk tutar.

Docker kaynağı kalıcı okuma checkpoint'i tutmaz. Vector kapalıyken oluşan loglar yeniden başlangıçta eksik kalabilir; kaynak tam kayıpsızlık garantisi vermez. Disk kuyruğu yalnız Vector'ün zaten aldığı logları korur. Docker'ın kendi log rotasyonunu mevcut uygulamalarda açık tut.

Vector Docker API erişimi için socket bağlar. `:ro` mount Docker API'yi salt okunur yapmaz; bu container'a Docker yetkisi verir. Socket'i TCP üzerinden yayınlama. Rootless Docker kullanıyorsan `.env` içindeki `DOCKER_SOCKET_PATH` değerini güncelle.

Komutları `services/logs` dizininde çalıştır:

```sh
docker compose ps
docker compose logs --tail=100 vector
./scripts/smoke-test.sh
docker compose stop
docker compose start
```

`docker compose down` veriyi korur. `docker compose down -v` kalıcı logları ve gönderim kuyruğunu siler.

Resmi kaynaklar: [VictoriaLogs + Vector](https://docs.victoriametrics.com/victorialogs/data-ingestion/vector/), [Docker log kaynağı](https://vector.dev/docs/reference/configuration/sources/docker_logs/), [saklama ve disk eşiği](https://docs.victoriametrics.com/victorialogs/#retention-by-disk-space-usage).
