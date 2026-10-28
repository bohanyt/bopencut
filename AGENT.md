# bopencut — ruang kerja bersama manusia + AI

**bopencut** adalah fork dari [OpenCut](https://github.com/opencut-app/opencut-classic) buatan tim OpenCut (lisensi MIT, lihat `LICENSE`). Semua kredit editor dasarnya milik mereka; fork ini hanya menambahkan jembatan agen dan beberapa perbaikan kecil. Dipakai untuk proyek video apa saja. Manusia mengedit di UI seperti biasa; agen (AI/skrip) bisa membaca dan mengubah timeline yang sama tanpa menimpa edit manusia.

## Menjalankan
```
bun install
cd apps/web && bunx next dev --turbopack -H 127.0.0.1 -p 3000
```
Tanpa akun/DB. Proyek tersimpan di browser (IndexedDB/OPFS).

## Folder kerja agen (`apps/web/.env.local`)
```
AGENT_WORKSPACE=C:\path\ke\folder-kerja     # default: <repo>/workspace
AGENT_FILES_ROOT=C:\path\ke\akar-aset        # default: = AGENT_WORKSPACE
```
Satu folder kerja per pekerjaan; ganti env lalu restart server untuk pindah proyek.

| File di AGENT_WORKSPACE | Arah | Isi |
|---|---|---|
| `bundle/bundle.json` | agen → editor | draf utuh; buka **/agent** → *Impor draf* = proyek baru |
| `project.json`, `sync/<projectId>.json` | editor → agen | timeline terkini setiap ada edit (debounce 0,8 s) |
| `draft.json` | agen → editor | operasi per item; diterapkan ±2 s sebagai **1 langkah Undo** |
| `draft-result.json` | editor → agen | hasil per operasi (item yang dihapus manusia dilewati) |

**bundle.json** (`schema` bebas): `name,width,height`, `assets:[{key,path(relatif AGENT_FILES_ROOT),type:image|video|audio,name}]`, `main:[el]`, `audio:[el]`, `overlay:[{name,type:"video"|"effect",elements:[el]}]` (index 0 = paling atas). `el`: `agent_id,name,start,duration,trimStart` (detik), `asset` atau `effect`+`effectParams`, `params` (mis. `transform.positionX/Y` = piksel dari pusat kanvas, `opacity`, `volume`), `size:[w,h]` (ukuran tampil piksel), `keyframes:[{path:"opacity"|"scale"|param,time,value}]`.

**draft.json**: `{schema:"opencut-agent-draft-1", rev, label, projectId?, ops:[{op:"set", match:{agentId}|{id}, start?, duration?, trimStart?, params?}, {op:"delete", match:…}, {op:"add", track:{name, type?:"video"|"audio"|"effect", index?}, element:el}]}`. Pada `add`, `el.asset` berupa objek `{path,type,name}` (bukan key bundle); trek dengan nama itu dipakai kalau sudah ada, kalau belum dibuat (overlay disisipkan di `index`). Seluruh draf = satu Undo; item yang diubah/ditambah langsung terpilih.

Konsol browser: `window.agent.snapshot()`, `window.agent.applyDraft(draft)`.

## Ubahan lain dari upstream
- GIF yang di-drop diubah ke MP4 bisu (ffmpeg lokal) supaya bergerak.
- Perbaikan: preview putus pada trek efek (`effect_pass_groups`).
- Dibuang: React Scan, indikator dev Next, analitik databuddy.

## Catatan selera

Sebelum menyusun bundle atau draf, baca `PREFERENCES.md` umum di folder `AGENT_PREFS` dan `AGENT_WORKSPACE/PREFERENCES.md` untuk proyek/channel jika ada. Kedua file bersifat pribadi dan tidak disimpan di repo. Editor tidak membacanya.

Edit manusia dicatat di `AGENT_WORKSPACE/edits/<projectId>.jsonl`. Jalankan `bun apps/web/scripts/edits-summary.ts <AGENT_WORKSPACE> [workspace lain...]` (tambahkan `--json` untuk JSON). Tulis aturan baru hanya jika pola muncul minimal 3 kali. Setiap aturan memuat aturan, bukti jumlah kejadian dan proyek, serta tanggal; manusia bebas mengedit atau menghapusnya. Contoh format ada di `PREFERENCES.example.md`.

## Catatan dan frame

Bookmark pada ruler juga menjadi catatan: tekan tombol bookmark di playhead (pilih elemen sebelumnya untuk mengaitkannya), lalu klik dua kali marker untuk mengisi teks, durasi, warna, menyelesaikan, atau menghapusnya. Marker agen berwarna oranye; marker selesai berwarna abu-abu. `notes` pada snapshot berisi `{id,text,start,end?,elementIds,replies,author,resolved,createdAt}`; waktu dalam detik. Bookmark lama yang belum memiliki teks tidak masuk daftar catatan.

Tambahkan operasi `{op:"note", text, start, end?, match?:[{agentId}|{id}]}` atau `{op:"resolve-note", id}` atau `{op:"reply-note", id, text}` ke `ops` pada draf. Hasilnya termasuk id catatan dan status per operasi di `draft-result.json`, dan seluruh draf tetap satu Undo. Karena bookmark memakai satu posisi per frame, penambahan pada posisi yang sudah ada ditolak dan dilaporkan.

Tulis `frames-request.json`: `{rev:"ambil-1", times:[0,1,2], width:960}`. `rev` hanya boleh berisi huruf, angka, `_`, atau `-`; waktu harus di dalam timeline. `width` opsional (default 960, maksimal 4096), tinggi mengikuti rasio kanvas. Editor aktif memproses permintaan saat tidak ada drag; `frames-result.json` berisi `{rev,files:["frames/ambil-1/0.jpg",...],projectId}` setelah semua frame tersimpan. Gunakan `rev` baru untuk permintaan berikutnya.

## Model 3D
Aset `type:"model"` menerima GLB atau glTF dengan sumber daya tertanam. Pada elemen, gunakan `model3d:{params:{rotationY:0,modelScale:1,cameraDistance:3.5,cameraFov:45,lightIntensity:2,lightX:3,lightY:4,lightZ:5}}`; `rotationX/Y/Z` dalam derajat. Parameter angka dapat dianimasikan lewat `keyframes` (mis. `path:"rotationY"`). Transform dan opacity bekerja seperti elemen gambar.
