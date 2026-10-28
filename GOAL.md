# Tujuan bopencut

**Dari skrip ke video jadi, dengan AI mengerjakan sebagian besar dan manusia memegang kendali penuh, di satu timeline yang sama.**

## Alur kerja

```
  skrip ─▶ 1. AI menyusun draf ─▶ 2. manusia mengedit ─▶ 3. AI merapikan ─▶ export
              ▲                         ▲     │                │
              │                         │     │                │
              │                         └─────┼────────────────┘  (ulang sampai jadi)
              │                               ▼
              └──── dibaca di draf berikutnya ── 4. AI mencatat selera
```

1. **AI menyusun draf awal seluruh video dari skrip.** Target: sekitar 75% jadi, termasuk VO, caption, footage, motion graphic, dan transisi. Semuanya berupa elemen yang bisa diedit, bukan video yang terkunci.
2. **Manusia mengedit langsung.** Menggeser, memotong, dan me-resize di timeline dan preview; menambah PNG, GIF, atau footage sendiri.
3. **Manusia menyuruh AI merapikan bagian tertentu.** Contohnya "transisi di sini kurang" atau "mograph ini kosong". AI melihat keadaan terkini, termasuk editan manusia, lalu mengubah hanya bagian itu. Hasilnya bisa di-Undo dengan satu langkah dan tidak menimpa editan manusia.
4. **AI belajar dari editan manusia.** Setiap editan manusia pada item buatan AI dicatat (apa yang diubah, dari berapa ke berapa). AI meringkasnya jadi aturan selera, misalnya "caption selalu dinaikkan ±40 px" atau "potongan meme dipendekkan ±0,4 s". Aturan baru ditulis kalau pola yang sama muncul **minimal 3 kali**, lengkap dengan buktinya. Manusia boleh mengubah atau menghapus aturan itu. Sebelum menyusun draf berikutnya, AI wajib membacanya, supaya editan yang sama tidak perlu diulang.

Catatan selera ada dua tingkat:
- **Umum**, berlaku untuk semua proyek: `PREFERENCES.md` di folder yang ditunjuk `AGENT_PREFS`.
- **Per proyek/channel:** `PREFERENCES.md` di `AGENT_WORKSPACE`.

Isinya pribadi, jadi tidak disimpan di repo publik ini. Repo hanya berisi mekanismenya.

## Penyaring fitur

Fitur baru hanya dikerjakan kalau membuat salah satu langkah di atas **lebih cepat atau lebih baik**. Kalau tidak jelas langkah mana yang terbantu, fitur itu ditunda.

- Hal khusus satu proyek (adegan tertentu, gaya channel tertentu) tidak masuk repo ini. bopencut hanya berisi kemampuan umum: primitif, preset, dan jalur agen.
- Uji pakai adegan nyata boleh, tapi adegan itu bahan uji, bukan fitur.

## Tahapan

Setiap tahap dianggap selesai kalau **kriteria "selesai kalau"** terpenuhi dan dicoba langsung di editor.

| # | Tahap | Langkah yang terbantu | Selesai kalau |
|---|---|---|---|
| 0 | Jembatan agen: impor draf, sinkron timeline, draf set/add/delete | 1, 3 | ✅ AI menambah, mengubah, dan menghapus item di proyek yang terbuka; satu Undo membatalkan semuanya |
| 1 | **Catatan di timeline + AI melihat frame** | 3 | Manusia menandai rentang waktu/item dengan catatan; AI membaca catatan itu dan bisa mengambil gambar frame mana pun |
| 1b | **Log editan + catatan selera** | 4 → 1 | Editan manusia pada item AI tercatat di `edits/<projectId>.jsonl`; AI menulis aturan selera dari pola berulang, dan draf berikutnya sudah memakai aturan itu |
| 2 | **Bahan mograph:** ikon (Iconify), garis/panah/path, grup, progres gambar | 1, 3 | AI menyusun satu adegan dari ikon dan bentuk; tiap bagian bisa di-drag dan di-resize di preview |
| 3 | **Gerak hidup + transisi:** easing, memantul, bergiliran, preset muncul/pindah/hilang, transisi antar klip | 1, 3 | Adegan tahap 2 bergerak tanpa terlihat kaku; manusia bisa mengganti preset per elemen |
| 4 | **Sebelum/sesudah:** bayangan state lain + lintasan di preview | 2 | Posisi awal dan akhir animasi terlihat dan bisa ditarik langsung |
| 5 | **Kedalaman:** bayangan, gradasi, parallax, kamera (zoom/geser) | 1 | Adegan punya kedalaman tanpa render di luar editor |
| 6 | **3D:** elemen model 3D dan teks 3D (Three.js), dirender per frame | 1 | Model 3D tampil di preview dan export sama persis; posisi/putaran bisa di-keyframe |
| 7 | **Skrip → draf umum:** format draf dari skrip + VO yang tidak bergantung pada proyek tertentu | 1 | Skrip baru jadi draf di editor tanpa kode khusus proyek |

## Belakangan

- Lottie (animasi siap pakai)
- Penerjemah scene Manim lama → primitif
- Morph bentuk A → B, grafik data
- Rekam suara di editor
