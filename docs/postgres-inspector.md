# PostgreSQL inceleyici ve SQL çalışma alanı

Log konsolundaki `PostgreSQL` bölümü sunucudaki PostgreSQL'i gösterir: sürüm, çalışma süresi, bağlantılar, önbellek isabet oranı, uzun süren sorgular, veritabanı ve tablo boyutları, kolonlar, index'ler, kısıtlar, tablo satırları ve SSMS benzeri bir SQL çalışma alanı. Varsayılan davranış salt okunurdur. Açıkça açılan **yazma modu** ile SQL ifadeleri önizlenip onaylanarak uygulanabilir ve tablo satırları birincil anahtarla düzenlenebilir.

PostgreSQL bu repo tarafından yönetilmez. Ayrı `databases` Compose projesinde (`/opt/databases`) çalışır ve konsolun zaten katıldığı `databases_default` ağındadır. Bağlantı bilgisi yalnız `POSTGRES_URL` secret'ından gelir (eski ad `POSTGRES_READONLY_URL` hâlâ yedek olarak okunur).

## Güvenlik katmanları

- **Asıl koruma rol yetkileridir.** Konsol superuser olmayan bir rolle bağlanmalıdır. Superuser ile bağlanılırsa konsol ilk bağlantıda bunu algılar, loga `WARNING: POSTGRES_URL connects as a PostgreSQL superuser` yazar ve arayüzde "superuser ile bağlı" uyarısı gösterir.
- **Okumalar:** Her istek kendi kısa ömürlü bağlantısını açar; aynı anda en fazla 3 bağlantı olur. İşler `BEGIN READ ONLY` içinde, `statement_timeout = 5s`, `lock_timeout = 2s` ve `idle_in_transaction_session_timeout = 15s` ile çalışır ve sonunda `ROLLBACK` yapılır. Rol yazabiliyor olsa bile okuma uçları yazamaz.
- **Yazmalar:** Yalnız yazma uçları normal `READ WRITE` işlem açar (`statement_timeout = 5s`, `lock_timeout = 3s`, `idle_in_transaction_session_timeout = 15s`). Önizleme ifadeyi çalıştırıp geri alır; commit açık onay ister. Ayrıntılar aşağıda.
- **Tek ifade:** SQL extended protocol ile gider; birden fazla ifade reddedilir. `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` gibi işlem kontrolü reddedilir (`transaction_control`).
- **Sözcüksel koruma (best effort):** `COPY` ve sunucu dosyası/program çalıştıran fonksiyonlar (`pg_read_file`, `pg_read_binary_file`, `pg_ls_*`, `pg_stat_file`, `lo_import`, `lo_export`, `pg_file_*`, `dblink*`, `postgres_fdw*`, güvenilmeyen PL dilleri vb.) hem okuma hem yazma yolunda `blocked_statement` ile reddedilir. Bu kontrol yorum, string, dollar-quote ve tırnaklı tanımlayıcıları atlayan sözcüksel bir taramadır; tam bir SQL ayrıştırıcısı değildir ve atlatılabilir. Güvenliği buna değil rol yetkilerine dayandır.
- **Sınırlar:** En fazla 500 satır, hücre başına 2000 karakter, yanıt başına 4 MB, SQL metni en fazla 20 000 karakter.
- **Gizlilik:** DSN ve şifre hiçbir yanıtta, hata mesajında veya logda görünmez. Sorgu metinlerindeki `PASSWORD '...'` değerleri gizlenir (`pg_stat_statements`, `pg_stat_activity` ve denetim logu dahil).
- **Kimlik belirteçleri:** Veritabanı adı her istekte `pg_database` listesiyle, şema, tablo ve kolon adları katalogla doğrulanır. Tanımlayıcılar `pgx.Identifier` ile tırnaklanır; satır düzenlemede değerler yalnız parametre olarak gider.

## 1. Container'ı ve ağ adını bul

VPS'te PostgreSQL container'ını, sürümünü ve `databases_default` ağındaki adını bul:

```sh
docker ps --format '{{.Names}}\t{{.Image}}' | grep -i postgres
docker exec <container> psql -U <superuser> -tAc 'SHOW server_version'
docker network inspect databases_default \
  --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
docker inspect <container> \
  --format '{{range $n, $v := .NetworkSettings.Networks}}{{$n}}: {{$v.Aliases}}{{"\n"}}{{end}}'
```

- **Host:** DSN'deki host, `databases_default` ağındaki container adı veya alias'ıdır (çoğunlukla `postgres`).
- **Superuser:** Genelde container'ın `POSTGRES_USER` değeridir (varsayılanı `postgres`). Yalnız rolü oluşturmak için kullan.
- **Sürüm:** `pg_read_all_data` ve `pg_write_all_data` için sürüm 14 veya üstü olmalı.

## 2. Önerilen rol: `logs_console`

Tek bir superuser olmayan rol, tüm veritabanlarını okuyup yazabilir. Superuser ile etkileşimli `psql` aç. Şifre komut satırına veya SQL'e yazılmaz; `\password` onu sorar ve sunucuya hash'lenmiş gönderir, böylece `pg_stat_statements` veya shell geçmişine düşmez.

```sh
docker exec -it <container> psql -U <superuser> -d postgres
```

```sql
CREATE ROLE logs_console LOGIN CONNECTION LIMIT 3;
\password logs_console
GRANT pg_read_all_data, pg_write_all_data, pg_monitor TO logs_console;
ALTER ROLE logs_console SET statement_timeout = '5s';
-- PUBLIC'in CONNECT yetkisi kaldırılmış veritabanları için:
GRANT CONNECT ON DATABASE <veritabanı> TO logs_console;
```

Güçlü bir şifre üret (URL'de kaçış gerektirmez):

```sh
openssl rand -hex 24
```

- **Yetkiler:** `pg_read_all_data` tüm tablo ve view'ları okur, `pg_write_all_data` tüm tablolara `INSERT`/`UPDATE`/`DELETE` yapar. `pg_monitor` `pg_stat_activity`, `pg_stat_statements` ve boyut fonksiyonlarını açar. Rol nesne sahibi olmadığı için `DROP`/`ALTER` gibi DDL'ler yalnız kendi oluşturduğu nesnelerde veya ek yetki verildiğinde çalışır.
- **Superuser:** Superuser DSN de çalışır, ama konsol uyarı gösterir ve `COPY ... PROGRAM` gibi tehlikeli işlerde tek koruma sözcüksel kontrol kalır. Önerilmez.
- **Bağlantı sınırı:** Konsol aynı anda en fazla 3 bağlantı açar; `CONNECTION LIMIT 3` bununla uyumludur.
- **pg_stat_statements:** En yavaş sorgular listesi için uzantının sunucuda yüklü (`shared_preload_libraries`) ve ilgili veritabanında `CREATE EXTENSION pg_stat_statements;` ile kurulu olması gerekir. Değilse sayfa bir ipucu gösterir.

### Daha güvenli seçenek: ayrı roller

Konsolun yazabileceği alanı daraltmak istersen ayrıcalıkları ayır. Salt okunur bir rol için:

```sql
CREATE ROLE logs_console_ro LOGIN CONNECTION LIMIT 3;
\password logs_console_ro
GRANT pg_read_all_data, pg_monitor TO logs_console_ro;
ALTER ROLE logs_console_ro SET default_transaction_read_only = on;
ALTER ROLE logs_console_ro SET statement_timeout = '5s';
```

Bu rolle yazma modu açılsa bile her yazma PostgreSQL tarafından reddedilir. Yazmayı tek bir şemayla sınırlamak için (ör. `app` veritabanındaki `public`):

```sql
CREATE ROLE logs_console_rw LOGIN CONNECTION LIMIT 3;
\password logs_console_rw
GRANT pg_read_all_data, pg_monitor TO logs_console_rw;
\c app
GRANT USAGE ON SCHEMA public TO logs_console_rw;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO logs_console_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO logs_console_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT INSERT, UPDATE, DELETE ON TABLES TO logs_console_rw;
```

Hangi rolü kullanırsan kullan DSN'e onu yaz. Hiçbirine superuser verme.

## 3. Secret'ı ekle ve deploy et

GitHub'da `Settings → Environments → logs-production → Environment secrets` altında `POSTGRES_URL` ekle:

```text
postgres://<rol>:<şifre>@<postgres-container-adı>:5432/postgres?sslmode=disable
```

- **Host:** 1. adımda bulduğun ad.
- **Veritabanı:** `postgres` önerilir. Bu yalnız ilk bağlantıdır; diğer veritabanları `pg_database` listesinden seçilir ve aynı kullanıcıyla bağlanılır.
- **TLS:** Sunucu iç Docker ağında TLS kullanmıyorsa `sslmode=disable` gerekir.
- **Kaçış:** Şifrede `@ : / ? # %` gibi karakterler varsa URL kaçışlı yaz (ör. `@` → `%40`).

Deploy sırasında:
- Workflow DSN'i doğrular ve release içinde mod `600` olan `services/logs/browser.env` dosyasına `POSTGRES_URL` olarak ekler. DSN komut argümanına veya loga girmez.
- Secret yoksa veya geçersizse PostgreSQL bölümü "yapılandırılmamış" gösterir ve `/api/pg/*` uçları `503` döner. Log konsolu etkilenmez.

### Yazmayı kapatma ve tüm erişimi kesme

- **Yazma anahtarı:** `Settings → Environments → logs-production → Environment variables` altında `POSTGRES_WRITE_ENABLED` değişkeni. Tanımsız veya `true` ise yazma modu kullanılabilir. `false` yapıp yeniden deploy edersen yazma uçları `403 write_disabled` döner ve arayüzdeki yazma modu düğmesi açıklamasıyla birlikte devre dışı kalır. Okuma etkilenmez. Başka değerler deploy'u durdurur.
- **Tüm PostgreSQL erişimi:** `POSTGRES_URL` (ve varsa eski `POSTGRES_READONLY_URL`) secret'ını silip yeniden deploy et. Konsol veritabanına hiç bağlanmaz; bölüm "yapılandırılmamış" gösterir.

## Yazma modu

- **Açma:** SQL çalışma alanında veya tablo sayfasında `Yazma modu` düğmesiyle açılır. Varsayılan kapalıdır, saklanmaz (sayfa yenilenince kapanır) ve açıkken başlık, editör kenarı ve durum çubuğu uyarı rengindedir.
- **Önizleme:** `Önizle` (F5, Cmd/Ctrl+Enter) ifadeyi gerçek bir işlemde çalıştırır, etkilenen satır sayısını ve varsa `RETURNING` çıktısını gösterir, sonra `ROLLBACK` yapar. İşlem dışı etkiler geri alınmaz: ör. sequence değerleri (`nextval`) ilerlemiş kalır.
- **Onay:** `Uygula` ifadeyi yeniden çalıştırır ve commit eder. Satır sayısı önizlemedekinden farklıysa hiçbir şey değişmez ve `409 rows_changed` döner.
- **Tehlikeli ifadeler:** DDL (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `SELECT INTO`…) ve `WHERE` içermeyen `UPDATE`/`DELETE` işaretlenir. Bunları uygulamak için veritabanı adını yazarak onaylaman gerekir.
- **Satır düzenleme:** Tablo sayfasında yazma modu açıkken satırlar eklenebilir, hücreler düzenlenebilir ve satırlar silinebilir. Yalnız birincil anahtarı olan tablolarda çalışır. Sorgular parametrelidir (`CAST($n::text AS <kolon tipi>)`), satır birincil anahtarın tüm kolonlarıyla seçilir ve tam olarak bir satır etkilenmezse işlem geri alınır (`409 row_count`).
- **Denetim logu:** Her commit konsolun stderr'ine yazılır ve Vector ile VictoriaLogs'a gider:

  ```text
  postgres write committed user="<kullanıcı>" session=<12 hex> db="shop" command="UPDATE" rows=1 statement="..."
  ```

  `session`, oturum çerezinin SHA-256 özetinin ilk 12 karakteridir. Satır düzenlemelerinde `table`, `op` ve `key` de yazılır. Log konsolunda `"postgres write committed"` ile aranabilir.

## SQL çalışma alanı

- **Nesne gezgini:** Veritabanı → şemalar → tablolar/view'lar → kolonlar (tip, PK, NOT NULL) ve index'ler. Adı editöre ekleme, `SELECT … LIMIT 100` sorgusunu yeni sekmede çalıştırma ve tablo sayfasını açma.
- **Sekmeler:** Birden fazla sorgu sekmesi; her biri kendi veritabanını ve metnini tutar. Eklenebilir, kapatılabilir, çift tıklayarak yeniden adlandırılabilir; tarayıcıda (`localStorage`) saklanır.
- **Editör:** PostgreSQL sözdizimi vurgusu; anahtar kelime, fonksiyon, `şema.tablo`, `alias.` kolonları ve `FROM`'daki tabloların kolonları için tamamlama (en fazla 2000 tablo). `Biçimlendir`, Cmd/Ctrl+Enter veya F5 ile çalıştırma (seçim varsa yalnız seçim), Cmd/Ctrl+/ ile yorum, hata konumu altı çizili gösterilir. Editör ve sonuç bölmesi arasındaki ayırıcı sürüklenebilir.
- **Sonuçlar:** Satır numaralı, yapışkan başlıklı ızgara; kolon genişliği ayarlanır, kolona tıklayınca yüklenen satırlar sıralanır, `NULL` ayrı gösterilir, hücre/satır kopyalanır. `Mesajlar` sekmesi süre, etkilenen satır ve PostgreSQL bildirimlerini (`NOTICE`), `Plan` sekmesi `EXPLAIN` çıktısını girintisiyle gösterir. CSV ve JSON indirme.
- **Durum çubuğu:** Veritabanı, kullanıcı, satır sayısı, süre ve mod (salt okunur / yazma).

## Uç noktalar

Hepsi konsol oturumu ister ve `/api/meili` ile aynı köken kurallarına tabidir:
- GET isteklerinde `X-Requested-With: logs-ui` gerekir; Origin gelirse eşleşmelidir.
- POST isteklerinde tam same-origin kontrolü yapılır.

| Yöntem | Yol | İçerik |
| --- | --- | --- |
| GET | `/api/pg/status` | `configured`, `invalid`, `superuser`, `writeEnabled` |
| GET | `/api/pg/overview` | Sürüm, çalışma süresi, durumlara göre bağlantılar / `max_connections`, önbellek isabeti, commit/rollback, deadlock, bekleyen kilitler, veritabanı boyutları, 5 sn'den uzun süren sorgular |
| GET | `/api/pg/db/{db}` | Şemalar; tablolar (tahmini satır, toplam/tablo/index boyutu, seq/idx scan, ölü satır, son vacuum/analyze); view'lar; uzantılar; bu veritabanının `pg_stat_statements` ilk 20 kaydı |
| GET | `/api/pg/db/{db}/schema` | Tamamlama ve gezgin için şema → tablo → kolonlar (tip, nullable, pk) ve nesne türleri; en fazla 2000 tablo (`truncated`) |
| GET | `/api/pg/db/{db}/table/{schema}/{table}` | Kolonlar, kısıtlar (PK/FK/unique/check), index'ler (tanım, boyut, scan, kullanılmayan), tetikleyiciler |
| GET | `/api/pg/db/{db}/table/{schema}/{table}/rows?limit&offset` | Satırlar; birincil anahtar varsa ona göre sıralı |
| POST | `/api/pg/db/{db}/query` | `{"sql": "...", "explain": false}`: tek ifade, salt okunur işlemde; kolonlar, satırlar, süre, kırpılma, bildirimler |
| POST | `/api/pg/db/{db}/write/preview` | `{"sql": "..."}`: çalıştırır ve geri alır; `rowsAffected`, `ddl`, `dangerous`, `reasons` (`ddl`, `no_where`) |
| POST | `/api/pg/db/{db}/write/commit` | `{"sql", "confirm": true, "confirmDatabase"?, "expectedRows"?}`: çalıştırır ve commit eder |
| POST | `/api/pg/db/{db}/table/{schema}/{table}/write` | `{"op": "insert"\|"update"\|"delete", "key", "values", "confirm": true}`: birincil anahtarla tek satır |

Yazma uçlarının hata kodları: `write_disabled` (403), `not_configured` (503), `confirmation_required`, `database_confirmation_required`, `transaction_control`, `blocked_statement`, `no_primary_key`, `not_a_table`, `invalid_row` (400), `rows_changed`, `row_count` (409).
