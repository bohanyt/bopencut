# bopencut — OpenCut + agen

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

**draft.json**: `{schema:"opencut-agent-draft-1", rev, label, projectId?, ops:[{op:"set", match:{agentId}|{id}, start?, duration?, trimStart?, params?}, {op:"delete", match:…}]}`.

Konsol browser: `window.agent.snapshot()`, `window.agent.applyDraft(draft)`.

## Ubahan lain dari upstream
- GIF yang di-drop diubah ke MP4 bisu (ffmpeg lokal) supaya bergerak.
- Perbaikan: preview putus pada trek efek (`effect_pass_groups`).
- Dibuang: React Scan, indikator dev Next, analitik databuddy.
