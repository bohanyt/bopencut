# Berkontribusi

bopencut adalah proyek pribadi yang dikembangkan bertahap menurut [GOAL.md](../GOAL.md). Issue dan usulan dipersilakan; PR dari luar mungkin tidak diterima kalau tidak sejalan dengan tahapan.

Aturan untuk setiap perubahan:

- Satu tahap atau satu perbaikan = satu cabang + satu PR ke `main`.
- CI harus hijau: `bun run build`, `bunx tsc --noEmit -p .`, dan `bun test` di `apps/web`.
- Deskripsi PR memuat isi perubahan, kriteria "selesai kalau" dari GOAL.md, dan bukti uji.
- Aturan untuk agen yang mengubah kode ada di [AGENTS.md](../AGENTS.md).

Menjalankan secara lokal: lihat [README.md](../README.md).
