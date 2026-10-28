# Agents.md

## Kamu AI yang diarahkan ke bopencut? Baca ini dulu

**bopencut adalah tempat kamu mengedit video bersama manusia.** Biasanya kamu diminta **membuat atau merapikan video**, bukan mengubah kode bopencut. Ubah kode hanya kalau pemilik memintanya secara eksplisit (aturannya di bagian bawah).

Yang bisa kamu pakai:
- **Timeline bersama:** kamu menyusun draf (VO, footage, caption, motion graphic, transisi), manusia mengedit langsung di UI, lalu kamu merapikan bagian yang ditunjuk. Semua perubahanmu bisa di-Undo dan tidak menimpa editan manusia.
- **Motion graphic yang tetap bisa diedit** (pengganti video Manim yang terkunci): ikon, kotak, lingkaran, garis, panah, dan path dengan efek "digambar"; grup objek; keyframe posisi, ukuran, rotasi, dan opacity. Setiap bagian adalah elemen sendiri yang bisa digeser dan di-resize manusia di preview.
- **Model 3D** (GLB/glTF) yang bisa diputar dan digerakkan lewat keyframe.
- **Preview langsung:** manusia mengecek hasil di preview editor tanpa render. Perubahan kecil cukup lewat draf; tidak perlu export dulu. Export MP4 hanya untuk hasil akhir.
- **Mata untukmu:** minta gambar frame pada detik mana pun untuk mengecek hasil kerjamu sebelum melapor.
- **Catatan dan selera:** baca catatan manusia di timeline dan file `PREFERENCES.md` sebelum menyusun draf; balas atau tandai catatan setelah dikerjakan.

Cara kerjanya (format draf, catatan, frame, selera, lokasi data): [`AGENT.md`](AGENT.md). Footage dan aset ada di folder terpisah yang ditunjuk `AGENT_FILES_ROOT`, bukan di repo ini; jangan mengubah file sumber di sana.

## Kalau diminta mengubah kode bopencut

- **Repo ini publik.** Jangan menulis atribusi AI di mana pun (tanpa baris co-author AI, tanpa nama model atau vendor AI), dan jangan menulis nama proyek, klien, channel, path laptop, atau data pribadi pemilik di kode, komentar, dokumen, maupun pesan commit. Hal khusus satu proyek tinggal di luar repo; bopencut hanya berisi kemampuan umum (lihat penyaring fitur di `GOAL.md`).
- Satu tahap = satu cabang + satu PR ke `main`. Jangan push langsung ke `main`.
- CI wajib hijau: di `apps/web`, `bun run build`, `bunx tsc --noEmit -p .`, dan `bun test`. Jangan membungkam error tipe (`@ts-ignore`, `any` untuk menghindari error, `ignoreBuildErrors`) dan jangan menghapus tes supaya lulus.
- Uji di browser hanya lewat otomasi tab browser. Jangan memakai kontrol desktop (mouse, keyboard, screenshot layar, atau clipboard sistem) di mesin pemilik.
- Data proyek dan folder kerja agen (`workspace/`, `BOPENCUT_DATA`, `AGENT_WORKSPACE`) tidak boleh dikomit.
- Ikuti gaya kode di sekitarnya. Komentar di file khusus bopencut (`src/agent`, dll.) singkat dalam bahasa Indonesia.
- Protokol folder kerja agen (bundle, draf, catatan, frame, selera) ada di `AGENT.md`; perbarui dokumen itu kalau formatnya berubah.

## Catatan arsitektur dari OpenCut

An ongoing migration is moving all business logic into `rust/`. Each app under `apps/` is a UI shell — it owns rendering, interaction, and platform-specific concerns, but never owns logic. The UI framework for any given app is a replaceable detail.

### `rust/`

The single source of truth for all non-UI code. Everything platform-agnostic belongs here: no components, no hooks, no framework imports.

### `apps/`

Each app is a frontend that calls into Rust. Logic is never duplicated between apps — only UI is, because each platform may use an entirely different framework and language to build it.

- `web/` — Next.js
- `desktop/` — GPUI

## Web

### React

- Read components before using them. They may already apply classes, which affects what you need to pass and how to override them.

