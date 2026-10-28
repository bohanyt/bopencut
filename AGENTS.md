# Agents.md

## Aturan bopencut (berlaku untuk semua agen yang mengubah kode)

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

