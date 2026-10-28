# bopencut — satu timeline untuk kamu dan AI

**bopencut** adalah editor video web tempat **manusia dan AI mengedit timeline yang sama**. AI menyusun draf video dari skrip; kamu menggeser, memotong, dan menata di UI seperti CapCut; lalu AI merapikan bagian yang kamu tunjuk. Semua perubahan AI bisa di-Undo, dan editanmu tidak tertimpa.

> bopencut adalah fork dari **OpenCut (classic)** buatan tim [OpenCut](https://github.com/opencut-app/opencut), lisensi MIT (lihat [`LICENSE`](LICENSE)). Editor dasarnya sepenuhnya karya mereka. README asli OpenCut: [`docs/opencut-readme-asli.md`](docs/opencut-readme-asli.md).

## Yang bisa dilakukan

**Kerja bareng AI**
- **AI tahu isi timeline:** setiap perubahan ditulis ke folder kerja sebagai JSON (trek, item, waktu, posisi, catatan).
- **AI ikut mengedit:** AI mengirim draf per item (tambah, ubah, hapus). Editor menerapkannya dalam ±2 detik sebagai **satu langkah Undo**, dan item yang diubah langsung terpilih.
- **Catatan dua arah:** tandai rentang waktu atau item dengan catatan; AI bisa membaca, membalas, dan menandai selesai.
- **AI melihat frame:** AI bisa meminta gambar frame pada detik mana pun.
- **AI belajar seleramu:** editanmu pada item buatan AI dicatat dan diringkas menjadi kandidat aturan selera.

**Editor**
- Proyek dan media disimpan **di folder, bukan di browser**, jadi bisa dibuka dari browser mana pun di laptop yang sama.
- Bahan motion graphic: ikon (Iconify), garis/panah/path dengan efek "digambar", grup objek.
- Model 3D (GLB/glTF) yang dirender per frame.
- Kualitas preview Penuh / ½ / ¼; export selalu resolusi penuh.
- GIF yang di-drop otomatis menjadi video bergerak.

## Menjalankan

Butuh [Bun](https://bun.sh); `ffmpeg` di PATH dipakai untuk mengubah GIF menjadi video. Tidak perlu akun, database, atau Docker.

```
bun install
cd apps/web && bunx next dev --turbopack -H 127.0.0.1 -p 3000
```

Buka `http://127.0.0.1:3000/projects`.

## Di mana data disimpan

| Apa | Lokasi default | Ganti dengan (`apps/web/.env.local`) |
|---|---|---|
| Proyek dan media | `<repo>/workspace/projects/` | `BOPENCUT_DATA` |
| Folder kerja agen (sync, draf, frame, log editan) | `<repo>/workspace/` | `AGENT_WORKSPACE` |
| Akar aset yang boleh dibaca agen | = `AGENT_WORKSPACE` | `AGENT_FILES_ROOT` |

`workspace/` tidak masuk Git. Kalau memakai folder lain, pastikan folder itu juga tidak dikomit. Data lama yang masih tersimpan di browser disalin otomatis ke folder saat pertama dibuka, tanpa menghapus aslinya.

## Memakai bopencut dengan AI lokal

Jalankan bopencut, lalu buka AI lokalmu (agen coding di terminal atau editor) di folder repo ini dan minta: **"baca `AGENTS.md`, lalu bantu aku mengerjakan video ini"**. `AGENTS.md` menjelaskan ke AI bahwa bopencut adalah tempat mengedit video bersama, fitur apa saja yang tersedia, dan bahwa kamu mengecek hasilnya lewat preview tanpa perlu render. Taruh footage dan asetmu di folder terpisah, lalu arahkan `AGENT_FILES_ROOT` ke sana.

## Dokumen

- [GOAL.md](GOAL.md): tujuan, alur kerja, dan tahapan.
- [AGENT.md](AGENT.md): protokol folder kerja agen (format bundle, draf, catatan, frame, selera).
- [AGENTS.md](AGENTS.md): titik masuk untuk AI (cara kerja di bopencut, dan aturan kalau mengubah kodenya).

## Lisensi

MIT, sama seperti OpenCut. Lihat [`LICENSE`](LICENSE).
