# Tarayıcıdan şifreli log erişimi

Hedef adres `https://logs.vefacaglar.com`. Kurulum ve günlük kullanım için VPS'e elle bağlanman gerekmez. GitHub secret'larını ve DNS kaydını sen ayarlarsın; workflow mevcut Caddy route'unu otomatik ekleyip doğrular ve yeniden yükler.

Akış: tarayıcı → mevcut Caddy (HTTPS) → Go `browser` servisi (oturum denetimi ve React client) → VictoriaLogs sorgu API'leri. Arayüz tamamen bize ait React + TypeScript client'tır (`services/logs/client/`); VictoriaLogs UI, iframe veya HTML/CSS enjeksiyonu kullanılmaz. Go servisi Vite çıktısını tek binary içine gömer. Node yalnız build aşamasında gerekir; VPS'teki Docker build bunu otomatik yapar. VictoriaLogs'un `9428` portu loopback'te kalır; browser servisinin host portu yoktur. Gateway yalnız açıkça listelenmiş `/select/logsql/*` okuma API'lerini geçirir; ingestion/yönetim yolları ve native VMUI asset'leri `404` döner.

## GitHub secrets

Repo'da `Settings → Environments → logs-production → Environment secrets` altında bu iki secret'ı ekle:

| Secret | Değer |
| --- | --- |
| `LOGS_UI_USERNAME` | Giriş kullanıcı adı, örneğin `vefa`. 1–64 karakter; harf, sayı, `_` veya `-`. |
| `LOGS_UI_PASSWORD` | Senin belirlediğin güçlü şifre. 12–72 UTF-8 byte; başta/sonda boşluk veya satır sonu olmamalı. ASCII bir şifre için 12–72 karakter. |

İsteğe bağlı üçüncü secret `LOGS_UI_TOTP_SECRET` girişe ikinci faktör ekler; kurulumu [aşağıda](#totp-ile-ikinci-faktör).

Şifreyi sohbete veya repo'ya koyma. Workflow şifreyi Caddy'ye stdin üzerinden verip bcrypt hash'i üretir. VPS'e yalnız kullanıcı adı ve hash (ve varsa `LOGS_UI_TOTP_SECRET` ile konsolun Meilisearch ve PostgreSQL bölümleri için `MEILI_MASTER_KEY` ile `POSTGRES_URL`) içeren `services/logs/browser.env` dosyası gider; dosya modu `600`dür. Açık şifre komut argümanına veya dosyaya yazılmaz. `browser.env` ve üretilen `compose.override.yml` Git tarafından yok sayılır.

Güncel dosyaları `main`e gönderip `Services CI and deploy` workflow'unu çalıştır. Her iki secret da boşsa önceki loopback kurulumu devam eder. Yalnız biri girilmişse deploy hata verir. İkisi varsa korumalı browser servisi eklenir. İkisini birden kaldırmak sonraki deploy'da browser servisini kapatır; mevcut Caddy route'u bu durumda 502 verir, VictoriaLogs açığa çıkmaz.

## Ortak Docker ağı

Browser servisi mevcut Caddy ile `databases_default` ağını kullanır. Workflow Caddy'nin bu ağ üzerinden browser servisine ulaşabildiğini doğrular. Farklı bir ağ/container/config yolu kullanıyorsan GitHub'da `Settings → Environments → logs-production → Environment variables` bölümündeki isteğe bağlı ayarları kullan; sunucudaki `.env` dosyasını elle düzenlemek gerekmez:

| Environment variable | Varsayılan / kullanım |
| --- | --- |
| `LOGS_PROXY_NETWORK` | Boşsa mevcut `.env` değeri veya `databases_default`. Caddy ile ortak, zaten mevcut Docker ağı. |
| `LOGS_CADDY_CONTAINER` | `caddy`. Mevcut ana Caddy container'ının adı. |
| `LOGS_CADDY_CONFIG_PATH` | Boş bırakılırsa container'ın `--config` argümanı veya `/etc/caddy/Caddyfile` otomatik bulunur. Gerekirse container içindeki mutlak yolu yaz. |

VictoriaLogs ve Vector kendi Compose ağlarında kalır; yalnız korumalı browser servisi ortak ağa eklenir.

Browser ayarları release içinde tutulur. Deploy başarısızsa önceki release'e dönüş, önceki kullanıcı adı/şifre hash'ini de geri getirir. Ana `.env` ve log volume'ları korunur.

## DNS

Cloudflare DNS'te `logs` adında A kaydı oluştur; önceki VPS adresin değişmediyse değer `187.126.24.87`. İlk kurulumda `DNS only` seç. HTTPS sertifikasını mevcut Caddy alır; sunucunun 80/443 portları mevcut Caddy'ye ulaşmalıdır.

## Otomatik Caddy kurulumu

`main`e güncel kodu gönderip `Services CI and deploy → Run workflow` çalıştırman yeterli. SSH kullanıcısı mevcut kalıcı Caddyfile'a yazabilmeli; VPS'te Python 3 bulunmalı. Workflow mevcut container'ın persistent mount'unu bulur, auth/API/Typesense bloklarını koruyarak yalnız [log domain route'unu](../services/logs/deploy/Caddyfile.example) ekler. Aynı route zaten varsa çoğaltmaz; başka bir servise giden mevcut log domain'ini sessizce değiştirmez.

Değişiklikten önce `/opt/logs-on-vps/caddy-backups/` altında dosya modu `600` olan yedek alınır. Dosyanın inode'u korunarak yazılır; tek dosya bind mount'unda da değişiklik görünür. Caddy doğrulaması ve reload başarısızsa eski dosya geri yazılıp tekrar yüklenir. Başka bir deployment aynı anda Caddyfile'ı değiştirmişse onun değişikliğinin üzerine yazılmaz ve workflow hata bildirir.

Ana Caddy'de şifre tutulmaz; giriş denetimi browser servisindedir. Caddy `--watch` veya `--resume` ile çalışıyorsa ya da config kalıcı bir mount'ta değilse workflow bu dosyayı değiştirmez. Standart mevcut Caddyfile kurulumu desteklenir.

## Giriş ve şifre değişikliği

[Log arayüzünü aç](https://logs.vefacaglar.com). `/login` sayfasında GitHub secret'larına girdiğin kullanıcı adı ve şifreyi kullan. Doğru girişten sonra `/` adresindeki özel log konsolu açılır. Tarayıcının Basic Auth penceresi artık kullanılmaz; mevcut secret'ları değiştirmek gerekmez.

Client vefacaglar.com'un monospace, keskin köşeli ve bronz vurgulu tasarımını kullanır. Türkçe/İngilizce ile açık/koyu tema giriş, konsol, gelişmiş sorgu ve alan inceleme ekranlarında ortaktır. Tercihler ilk boyamadan önce uygulanır; dil, tema ve gösterim saat dilimi tarayıcıda `logs.language`, `logs.theme`, `logs.zone` anahtarlarıyla saklanır. Arayüz etiketleri doğal büyük/küçük harf kullanır. Fira Code yerelden sunulur; üçüncü taraf font isteği yoktur. Log mesajları, alan adları/değerleri ve sorgular çevrilmez.

`/` log konsoludur: servis/seviye/zaman filtreleri, kaydırarak geçmiş yükleme, satır detayları, kopyalama ve JSONL indirme. `/explore` gelişmiş çalışma alanıdır: CodeMirror LogsQL editörü, alan/operatör tamamlama, Ctrl/⌘+Enter, pipeline sorguları, oturum içi geçmiş ve örnekler, yoğunluk grafiği ve sürükleyerek zaman aralığı seçimi, özel başlangıç/bitiş, Group/Table/JSON/Live görünümleri, gruplama, dinamik tablo sütunları, satır kaydırma, JSONL/CSV export. Alan detayındaki +/− düğmeleri pipeline'dan önce güvenli bir filtre ekler. Otomatik yenileme geçmişe gidildiğinde veya log detayı açıkken bekler.

`/overview` alan inceleme ekranıdır. Alanları, seçilen alanın en fazla 100 değerini ve adetlerini API üzerinden getirir. Bir değerden filtrelenmiş gelişmiş sorguya geçilebilir. Tüm iç gezinme React Router ile aynı sekmede olur. `/select/vmui/` eski yer imleri `/explore` adresine yönlenir; native VMUI dosyaları yayınlanmaz. Eski hash bağlantılarındaki sorgu/görünüm ve desteklenen zaman aralığı parametreleri aktarılır.

Canlı görünüm `/select/logsql/tail` akışını `fetch`/ReadableStream ile okur. UTF-8 karakterler ve parça sınırına bölünen JSON satırları korunur; durdurma isteği bağlantıyı iptal eder. En son 1.000 canlı kayıt bellekte tutulur. Canlı sorgular VictoriaLogs tail API'sinin pipeline kısıtlarına tabidir; uygun olmayan sorgu hata detayını gösterir. Go gateway canlı rota için normal 35 saniyelik yazma zaman aşımını kaldırır. Diğer sorgular 20 saniye timeout ile gönderilir.

Editörün dinamik stil etiketleri HTML başına üretilen CSP nonce'u kullanır; inline script izni verilmez. Sorgu geçmişi yalnız çalışma belleğinde saklanır ve çıkışta/oturum sona erdiğinde temizlenir. Başka uygulamalar veya native VictoriaLogs arayüzünden alınan DOM üzerinde çeviri yapılmaz.

Kayıtlar 100'er yüklenir. Aşağı kaydırmak veya `daha eski kayıtlar` düğmesine basmak sonraki sayfayı getirir. Başlangıç/bitiş zamanı sayfalar arasında sabit kalır; `yenile` yeni bir zaman aralığı açar. Eşit zaman damgaları stream ve mesaj ile sıralanır. Geç gelen geçmiş logların depoya eklenmesi veya retention silmeleri sırasında offset sayfalama gerçek bir veritabanı snapshot'ı değildir; tam aktarım garantisi vermez. Otomatik yenileme 5 saniyede bir çalışır; eski sayfalara geçildiğinde, bir log detayı açıkken veya sekme arka plandayken bekler. Sorgu başına 20 saniye ve geçmişte 1.000.000 offset sınırı vardır; çok geniş aralıkları daralt.

Oturum çerezi `Secure`, `HttpOnly`, `SameSite=Strict` ve `__Host-` öneki kullanır; 12 saat sonra sona erer. Oturumlar bellekte tutulur, servis yeniden başladığında yeniden giriş gerekir. Çıkış oturumu sunucuda iptal eder. Giriş denemeleri aşağıdaki brute-force korumasıyla sınırlıdır. Giriş, çıkış ve özel API POST istekleri aynı Origin ve özel istek başlığı gerektirir. Kullanıcı adı/şifre, doğrulama kodu ve loglar tarayıcı depolamasına yazılmaz.

## TOTP ile ikinci faktör

İsteğe bağlıdır. `LOGS_UI_TOTP_SECRET` secret'ı tanımlıysa giriş formu şifreyle birlikte authenticator uygulamasındaki 6 haneli kodu da ister (RFC 6238: SHA-1, 6 hane, 30 saniye). Secret yoksa giriş yalnız kullanıcı adı ve şifreyle çalışır.

**Kurulum**

1. Mac'te 20 baytlık rastgele bir secret üret (macOS'ta `base32` komutu yoktur; Linux'ta `openssl rand 20 | base32` de olur). Çıktı 32 karakterlik base32 metindir; sohbete, repo'ya veya ekran görüntüsüne koyma:

   ```sh
   python3 -c 'import base64, secrets; print(base64.b32encode(secrets.token_bytes(20)).decode())'
   ```

2. Secret'ı authenticator uygulamasına ekle (1Password, Aegis, Google Authenticator, Authy…). "Kurulum anahtarı gir" seçeneğinde hesap adına `logs`, anahtara 1. adımın çıktısını yaz; tür "zamana dayalı" kalsın. QR veya bağlantı isteyen uygulamalar için aynı secret'la şu URI kullanılır:

   ```text
   otpauth://totp/logs.vefacaglar.com:vefa?secret=<SECRET>&issuer=logs.vefacaglar.com&algorithm=SHA1&digits=6&period=30
   ```

   QR'ı çevrimiçi bir sitede üretme; secret o siteye gider. Yerelde `qrencode -t ANSIUTF8 '<URI>'` yeterlidir.

3. Aynı değeri `Settings → Environments → logs-production → Environment secrets` altına `LOGS_UI_TOTP_SECRET` adıyla ekle. Değer 16–64 baytlık base32 olmalı (26–103 karakter; boşluk, tire ve küçük harf kabul edilir). Geçersizse deploy VPS'e bağlanmadan durur.
4. `Services CI and deploy → Run workflow` çalıştır. Deploy bitince giriş sayfasında `Doğrulama kodu` alanı görünür.
5. Secret'ı kaydettiğin yerden başka bir yere not etme; yedek gerekiyorsa şifre yöneticinde tut.

**Davranış**

- Secret yalnız mod `600` olan `services/logs/browser.env` dosyasında durur; komut argümanına, loga veya tarayıcıya gitmez. Giriş sayfası yalnız "kod gerekiyor mu" bilgisini `GET /api/login` ile öğrenir.
- Yanlış kod yanlış şifre gibi işlenir: aynı `401` yanıtı ve aynı hata metni döner, aşağıdaki IP kilidine sayılır. Yanıttan şifrenin doğru olup olmadığı anlaşılmaz.
- Saat kayması için bir önceki ve bir sonraki 30 saniyelik kod da kabul edilir. Telefonun saati bundan fazla kayarsa kod reddedilir; otomatik saat ayarını aç.
- Her kod bir kez kullanılır. Kabul edilen kod ve ondan eski kodlar yeniden kabul edilmez; hemen ardından ikinci bir giriş için yeni kodu bekle (en fazla 30 saniye). Bu kayıt bellekte tutulur, servis yeniden başlayınca sıfırlanır.

**Telefon kaybolursa**

Giriş için başka bir yol yoktur; kurtarma GitHub üzerinden yapılır:

1. `LOGS_UI_TOTP_SECRET` secret'ını sil (`Environment secrets → Delete`).
2. `Run workflow` ile yeniden deploy et. Giriş yalnız şifreyle çalışır, eski oturumlar sona erer.
3. Yeni bir secret üretip kurulum adımlarını tekrarla. Eski secret artık geçersizdir.

Secret sızdıysa da aynı yolu izle: yeni secret üret, GitHub'da güncelle, deploy et, uygulamadaki eski kaydı sil. Eski release'e rollback o release'in secret'ını (veya secret'sız halini) geri getirir.

## Brute-force koruması

- **İstemci IP'si:** Caddy'nin `reverse_proxy` yönergesi `X-Forwarded-For` başlığına gerçek istemci adresini ekler. Go servisi bu başlığa yalnız doğrudan bağlantı özel ağdan (Docker ağı, loopback) geliyorsa güvenir ve en sağdaki, yani Caddy'nin eklediği değeri kullanır; istemcinin sahte değerleri yok sayılır. IPv6 adresleri `/64` ağına göre sayılır. Cloudflare proxy (turuncu bulut) açılırsa tüm istekler Cloudflare adreslerinden gelir; bu koruma `DNS only` kurulumuna göre tasarlanmıştır.
- **IP başına kilit:** Yalnız başarısız denemeler sayılır. Bir IP 15 dakika içinde 5 kez başarısız olursa 15 dakika kilitlenir. Her yeni kilit süreyi ikiye katlar (30 dk, 1 sa, 2 sa … en fazla 24 sa). Son kilidin bitiminden sonra 24 saat sorunsuz geçerse süre yeniden 15 dakikadan başlar. Başarılı giriş o IP'nin sayacını sıfırlar. Kilitliyken istek `429` ve `Retry-After` ile döner; bcrypt çalışmaz ve şifre doğru da olsa yanlış da olsa aynı yanıt verilir. Aynı IP'den aynı anda tek doğrulama yapılır.
- **Genel sınır:** Tüm IP'lerden son bir saatte toplam 100 başarısız deneme olursa, son 30 gün içinde başarılı giriş yapmamış IP'ler sayı düşene kadar `429` alır. Son 30 günde giriş yapılmış IP'ler bu sınırdan muaftır (IP başına kilitten değil). Bu liste bellekte tutulur ve servis yeniden başlayınca sıfırlanır.
- **Kaynak sınırları:** En fazla 10.000 IP izlenir (dolunca en eski kayıt silinir), en fazla 256 güvenilir IP tutulur, aynı anda en fazla 4 bcrypt doğrulaması çalışır.

Her başarısız giriş `login failed`, her kilit `login locked`, her başarılı giriş `login succeeded` satırı olarak loglanır. Satırlarda IP, denenen kullanıcı adı (en fazla 64 bayt), başarısız deneme sayısı ve kilit süresi bulunur; şifre asla yazılmaz. Genel sınır devreye girdiğinde bir kez `login global limit engaged` yazılır. Log konsolunda:

```text
compose_service:browser ("login failed" OR "login locked" OR "login global limit")
```

Şifreyi değiştirmek için `LOGS_UI_PASSWORD` secret'ını güncelle ve tekrar `Run workflow` çalıştır. Browser servisi yeni hash ile yeniden oluşturulur, eski oturumlar sona erer. Eski release'e rollback eski hash'i de geri getirir.

Kurulumdan sonra Mac'te `curl -s -o /dev/null -w '%{http_code}\n' https://logs.vefacaglar.com/` isteği girişsiz `303` ile `/login` sayfasına yönlenmeli; `/api/session` ve sorgu API'leri girişsiz `401` dönmeli. Giriş sayfası `200` dönmeli; `/metrics` gibi yönetim yolları girişten sonra bile `404` kalmalı. CI oturum korumasını Go testleriyle, arayüz/proxy davranışlarını gerçek Caddy ve VictoriaLogs container'larıyla test eder. Gerçek DNS/HTTPS sertifikası sunucudaki route etkinleşince doğrulanır.

Yerel geliştirme:

```sh
cd services/logs/client
npm ci
npm test
npm run build
cd ../console
go test -race ./...
```

`npm run build` çıktıyı `services/logs/console/static/` içine üretir; derlenmiş asset'ler Git'e alınmaz. `LOGS_UI_USERNAME` ve bcrypt `LOGS_UI_PASSWORD_HASH` ile `go run .` servisi başlatır; `LOGS_UI_TOTP_SECRET` verilirse ikinci faktör yerelde de açılır. Yalnız HTTP yerel testleri için `LOGS_INSECURE_COOKIE=1` kullanılabilir; üretim Compose dosyası bu ayarı içermez. İsteğe bağlı `LOGS_LISTEN` ve `VICTORIALOGS_URL` yerel portları ayarlar. HMR için ikinci terminalde `cd services/logs/client && npm run dev` kullan; Vite API isteklerini `127.0.0.1:18080` adresindeki Go servisine geçirir. Docker varsa repo kökünde `RUN_BROWSER_TEST=1 python3 -m unittest discover -s tests -p 'test_browser.py' -v` gerçek container kontrolünü çalıştırır. CI client test/build, Go race testleri, Linux deploy testleri ve gerçek Docker ingestion/giriş/API izolasyonunu doğrular.

Resmi kaynaklar: [Caddy şifre hash'leme](https://caddyserver.com/docs/command-line#caddy-hash-password), [VictoriaLogs sorgu API'si](https://docs.victoriametrics.com/victorialogs/querying/), [VictoriaLogs sorgu yetkisi](https://docs.victoriametrics.com/victorialogs/security-and-lb/#search-authorization).
