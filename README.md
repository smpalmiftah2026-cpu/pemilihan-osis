# Pemilihan OSIS SMP/SMA Al-Miftah — RFID USB + Supabase + GitHub Pages

Starter app tanpa build tool. Cocok untuk reader RFID USB yang bekerja sebagai **keyboard/HID**: saat kartu ditempel, UID diketik otomatis lalu reader mengirim Enter.

## Isi folder
- `index.html` — aplikasi utama
- `styles.css` — desain modern responsif
- `app.js` — login, dashboard, grafik, pemanggilan siswa, import Excel, RFID voting
- `config.js` — isi URL dan publishable/anon key Supabase
- `supabase-schema.sql` — database, RLS, dan RPC anti pilih dua kali
- `template-siswa.xlsx` — template import siswa

## Alur kerja
1. Admin login.
2. Pilih SMP atau SMA.
3. Import siswa Excel.
4. Tambah Paslon A dan B + foto.
5. Daftarkan UID kartu RFID khusus Paslon A dan B.
6. Operator memanggil siswa.
7. Siswa masuk bilik; tempel kartu A atau B.
8. RPC database memeriksa siswa belum memilih, mencocokkan kartu, menyimpan suara, lalu menandai siswa sudah memilih.
9. Grafik dashboard diperbarui.

## Keamanan inti
- Jangan taruh `service_role` key di GitHub/Browser.
- Gunakan publishable key/anon key + RLS.
- Tabel votes tidak menerima INSERT langsung dari browser. Suara masuk melalui `submit_vote()`.
- Database memiliki unique constraint `(election_id, student_id)`, sehingga satu siswa tidak dapat memiliki dua suara dalam pemilihan yang sama.

Baca panduan pemasangan lengkap pada jawaban ChatGPT yang menyertai paket ini.
