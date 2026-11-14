# PostgreSQL inceleyici (salt okunur)

Log konsolundaki `PostgreSQL` bölümü sunucudaki PostgreSQL'i salt okunur gösterir: sürüm, çalışma süresi, bağlantılar, önbellek isabet oranı, uzun süren sorgular, veritabanı ve tablo boyutları, kolonlar, index'ler, kısıtlar, tablo satırları ve tek ifadelik SQL editörü. PostgreSQL bu repo tarafından yönetilmez; ayrı `databases` Compose projesinde (`/opt/databases`) çalışır ve konsolun zaten katıldığı `databases_default` ağındadır. Bağlantı bilgisi yalnız `POSTGRES_READONLY_URL` secret'ından gelir.

## Güvenlik katmanları

- **Rol:** Yazma yetkisi olmayan ayrı bir login rolü (`pg_read_all_data` + `pg_monitor`, PostgreSQL 14+). Rolün kendisi `default_transaction_read_only = on` ve `statement_timeout = 5s` ile gelir, en fazla 3 bağlantı açabilir.
- **Konsol:** Rol ne olursa olsun (yanlışlıkla superuser verilse bile) her istek kendi kısa ömürlü bağlantısını açar. Aynı anda en fazla 3 bağlantı olur. Bağlantı `default_transaction_read_only=on` ile başlar. İşler `BEGIN READ ONLY` içinde, `SET LOCAL` ile ayarlanan `statement_timeout = 5s`, `lock_timeout = 2s` ve `idle_in_transaction_session_timeout = 15s` ile çalışır ve sonunda `ROLLBACK` yapılır.
- **SQL editörü:** Sorgu extended protocol ile gider; birden fazla ifade reddedilir. İfadenin oturumda değiştirdiği her şey bağlantıyla birlikte kapanır.
- **Sınırlar:** En fazla 500 satır, hücre başına 2000 karakter, yanıt başına 4 MB.
- **Gizlilik:** DSN ve şifre hiçbir yanıtta, hata mesajında veya logda görünmez. Sorgu metinlerindeki `PASSWORD '...'` değerleri gizlenir (`pg_stat_statements` ve `pg_stat_activity` dahil).
- **Kimlik belirteçleri:** Veritabanı adı sunucudaki listeyle, şema ve tablo adı katalogla doğrulanır. Tanımlayıcılar `pgx.Identifier` ile tırnaklanır; kullanıcı girdisi SQL'e gömülmez.

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
- **Superuser:** Genelde container'ın `POSTGRES_USER` değeridir (varsayılanı `postgres`).
- **Sürüm:** `pg_read_all_data` için sürüm 14 veya üstü olmalı.

## 2. Salt okunur rolü oluştur

Superuser ile etkileşimli `psql` aç. Şifre komut satırına veya SQL'e yazılmaz; `\password` onu sorar ve sunucuya hash'lenmiş gönderir. Böylece şifre `pg_stat_statements` veya shell geçmişine düşmez.

```sh
docker exec -it <container> psql -U <superuser> -d postgres
```

```sql
CREATE ROLE logs_console_ro LOGIN CONNECTION LIMIT 3;
\password logs_console_ro
GRANT pg_read_all_data, pg_monitor TO logs_console_ro;
ALTER ROLE logs_console_ro SET default_transaction_read_only = on;
ALTER ROLE logs_console_ro SET statement_timeout = '5s';
-- Görmek istediğin her veritabanı için (PUBLIC'in CONNECT yetkisi kaldırıldıysa gerekli):
GRANT CONNECT ON DATABASE <veritabanı> TO logs_console_ro;
```

Şifreyi `\password` yerine SQL içinde vermek istersen `CREATE ROLE logs_console_ro LOGIN PASSWORD '<şifre>' CONNECTION LIMIT 3;` kullan. Bu durumda ifade `pg_stat_statements` içinde kalabilir. Konsol bu tür değerleri gizler, ama `\password` daha temizdir.

Güçlü bir şifre üret (URL'de kaçış gerektirmez):

```sh
openssl rand -hex 24
```

- **Rolün yetkileri:** `pg_read_all_data` tüm tablo ve view'ları okur, yazamaz. `pg_monitor` `pg_stat_activity`, `pg_stat_statements` ve boyut fonksiyonlarını açar.
- **Bağlantı sınırı:** Konsol aynı anda en fazla 3 bağlantı açar; `CONNECTION LIMIT 3` bununla uyumludur.
- **pg_stat_statements:** En yavaş sorgular listesi için bu uzantının sunucuda yüklü (`shared_preload_libraries`) ve ilgili veritabanında `CREATE EXTENSION pg_stat_statements;` ile kurulu olması gerekir. Değilse sayfa bir ipucu gösterir.

## 3. Secret'ı ekle ve deploy et

GitHub'da `Settings → Environments → logs-production → Environment secrets` altında `POSTGRES_READONLY_URL` ekle:

```text
postgres://logs_console_ro:<şifre>@<host>:5432/postgres?sslmode=disable
```

- **Host:** 1. adımda bulduğun ad.
- **Veritabanı:** Bağlanılacak ilk veritabanıdır. Diğer veritabanları `pg_database` listesinden seçilir ve aynı DSN ile bağlanılır.
- **TLS:** Sunucu iç Docker ağında TLS kullanmıyorsa `sslmode=disable` gerekir.
- **Kaçış:** Şifrede `@ : / ? # %` gibi karakterler varsa URL kaçışlı yaz (ör. `@` → `%40`).

Deploy sırasında:
- Workflow DSN'i doğrular ve release içinde mod `600` olan `services/logs/browser.env` dosyasına ekler. DSN komut argümanına veya loga girmez.
- Secret yoksa veya geçersizse PostgreSQL bölümü "yapılandırılmamış" gösterir ve `/api/pg/*` uçları `503` döner. Log konsolu etkilenmez.

## Uç noktalar

Hepsi konsol oturumu ister ve `/api/meili` ile aynı köken kurallarına tabidir:
- GET isteklerinde `X-Requested-With: logs-ui` gerekir; Origin gelirse eşleşmelidir.
- POST isteklerinde tam same-origin kontrolü yapılır.

| Yöntem | Yol | İçerik |
| --- | --- | --- |
| GET | `/api/pg/overview` | Sürüm, çalışma süresi, durumlara göre bağlantılar / `max_connections`, önbellek isabeti, commit/rollback, deadlock, bekleyen kilitler, veritabanı boyutları, 5 sn'den uzun süren sorgular |
| GET | `/api/pg/db/{db}` | Şemalar; tablolar (tahmini satır, toplam/tablo/index boyutu, seq/idx scan, ölü satır, son vacuum/analyze); view'lar; uzantılar; bu veritabanının `pg_stat_statements` ilk 20 kaydı |
| GET | `/api/pg/db/{db}/table/{schema}/{table}` | Kolonlar, kısıtlar (PK/FK/unique/check), index'ler (tanım, boyut, scan, kullanılmayan), tetikleyiciler |
| GET | `/api/pg/db/{db}/table/{schema}/{table}/rows?limit&offset` | Satırlar; birincil anahtar varsa ona göre sıralı |
| POST | `/api/pg/db/{db}/query` | `{"sql": "...", "explain": false}`: tek ifade, salt okunur işlemde; kolonlar, satırlar, süre, kırpılma bilgisi |
