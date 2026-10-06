# Renamer

Utility local para aplanar carpetas y renombrar archivos por patrón, con vista
previa obligatoria y deshacer. Corre en la Mac (`hq.local`) y se usa desde
cualquier equipo de la red.

**URL:** http://hq.local:7845 · http://192.168.68.101:7845

---

## Instalar

Todo esto va **en la Mac**, no en otra máquina.

```bash
cd ~/homelab/renamer
cp renamer.config.example.json renamer.config.json   # y ajusta "roots"
npm install
npm run build
npm start              # prueba rápida en primer plano, Ctrl+C para salir
```

`renamer.config.json` no va en el repo: trae las rutas reales de la máquina.

Abre http://localhost:7845. Si responde, instálalo como servicio permanente:

```bash
./scripts/install-launchd.sh
```

Eso lo registra como LaunchAgent: arranca al iniciar sesión y se reinicia solo
si se cae. No usa Docker a propósito: la herramienta ve `/Volumes/Media` con la
misma ruta que tú, y eso elimina la traducción de rutas host↔contenedor, que es
la fuente principal de errores en una utility de archivos.

Para quitarlo:

```bash
launchctl bootout gui/$(id -u)/com.alfredo.renamer
rm ~/Library/LaunchAgents/com.alfredo.renamer.plist
```

---

## Configuración

`renamer.config.json`:

```json
{
  "port": 7845,
  "host": "0.0.0.0",
  "roots": ["/Volumes/Media", "/Users/alfredogutierrez/Downloads"],
  "ignoreNames": [".DS_Store", "Thumbs.db", "desktop.ini"],
  "historyLimit": 500
}
```

`roots` **es el límite de seguridad**, no una comodidad. No hay login (igual que
el resto del homelab), así que lo único que evita que una petición toque
cualquier parte del disco es esta lista: cada ruta que llega se resuelve con
`realpath`, se valida contra las roots, y se rechaza con 403 si queda fuera.
Resolver con realpath es lo que impide que un symlink dentro de una root
apunte afuera. Agregar una root es ampliar lo que la herramienta puede
reescribir: hazlo con intención.

`host: 0.0.0.0` es lo que permite entrar desde la PC. Si algún día quieres que
solo se use desde la Mac, cámbialo a `127.0.0.1`.

---

## Agregarlo a la landing del homelab

En `~/homelab/homepage/config/services.yaml`:

```yaml
- Renamer:
    icon: mdi-form-textbox
    href: http://192.168.68.101:7845
    description: Aplanar carpetas y renombrar por patrón
    siteMonitor: http://192.168.68.101:7845/health
```

Luego `docker compose restart` desde `~/homelab/homepage`. No lleva `server:` ni
`container:` porque no corre en Docker.

---

## Cómo funciona la regla

Tres modos, todos producen el mismo resultado interno:

| Modo | Para qué sirve |
| --- | --- |
| **Automático** | Detecta `S01E02`, `1x02`, `Episode 4`, `Capítulo 12`, `- 05`, `[04]`. No escribes nada. |
| **Patrón** | Escribes texto literal con `#` donde va el número y `*` para cualquier cosa. Un espacio en el patrón acepta espacio, punto, guion o guion bajo, así que `Episode #` también caza `Show.Episode.9.mkv`. |
| **Regex** | Expresión regular cruda. Grupos nombrados `(?<s>…)` y `(?<e>…)` para temporada y episodio. |

La plantilla de salida arma el nombre final con piezas:

| Pieza | Qué pone |
| --- | --- |
| `{#}` `{#:02}` | el número principal, con relleno de ceros opcional |
| `{e}` `{s}` | episodio y temporada por separado |
| `{1}` `{2}` | los números capturados por posición |
| `{ext}` | la extensión con punto, `.mkv` |
| `{resto}` | lo que sobra del nombre, con los puntos convertidos en espacios |
| `{nombre}` | el nombre original completo sin extensión |
| `{carpeta}` | el nombre de la carpeta elegida, normalmente el de la serie |
| `{n}` `{n:02}` | consecutivo dentro del plan |

Todo lo que no vaya entre llaves se copia literal, así que `S01E{#:02}-Akame ga
Kill{ext}` deja `S01E01-Akame ga Kill.mkv`. Si en vez del texto fijo usas
`{carpeta}`, la misma regla sirve para cualquier serie sin editarla:
`S01E{#:02}-{carpeta}{ext}`.

Una pieza desconocida o sin valor es un error visible en la fila, no un nombre
a medias.

---

## Decisiones que importan

**La vista previa es el producto.** No hay un flag de dry run: la tabla es la
pantalla principal y aplicar es un botón al final. Lo que se manda al servidor
son exactamente los pares origen→destino que se ven en pantalla, y el servidor
los revalida antes de tocar nada.

**El reparto de nombres va en dos pasadas.** Un archivo que ya está en su lugar
con su nombre tiene derecho preferente sobre ese nombre. Si otro archivo que se
va a renombrar quisiera el mismo, el que cede es el que se mueve. Sin esto, una
segunda corrida sobre la misma carpeta le robaría el nombre a lo que ya estaba
bien.

**Las colisiones se comparan en minúsculas** porque APFS es insensible a
mayúsculas por defecto: `S01E01.mkv` y `s01e01.mkv` son el mismo archivo en esa
Mac, aunque en Linux no lo serían.

**El apply va en dos fases** (origen → temporal → destino). Un plan puede pedir
`A→B` y `B→A`, y hacerlo directo pierde un archivo. Con la fase temporal
cualquier permutación es segura y el costo es un rename extra, gratis en el
mismo volumen. Si la segunda fase falla, el archivo regresa a su lugar original
antes de reportar el fallo.

**El undo no confía en los nombres.** Al aplicar se guarda el inode de cada
archivo, y al deshacer solo se revierte lo que sigue siendo el mismo archivo. Si
algo cambió después, ese movimiento se omite y se reporta, en lugar de pisar
trabajo nuevo. Por eso el historial distingue "deshecha" de "ya no se puede
deshacer".

**Solo `rmdir`, nunca `rm -r`.** Las carpetas vacías se borran con `rmdir`, que
falla si queda algo dentro. La herramienta no borra archivos nunca: solo los
mueve y los renombra.

---

## Desarrollo

```bash
npm test          # 24 tests del motor: matching, plantillas, colisiones, ciclos, undo
npm run typecheck
npm run dev       # recarga al guardar, requiere node >= 22.6
```

Los tests arman árboles de archivos reales en `os.tmpdir()`, no mocks del
sistema de archivos: un bug de rename se ve.

```
src/
├── server.ts        rutas HTTP y validación de entrada
├── config.ts        carga de config y resolución de roots
├── db.ts            historial y reglas guardadas (SQLite)
├── plan.ts          construcción del plan: el corazón
├── apply.ts         ejecución en dos fases y deshacer
├── rules/
│   ├── match.ts     los tres modos de identificación
│   └── template.ts  render del nombre final
└── fsx/
    ├── paths.ts     límite de las roots
    └── scan.ts      recorrido del disco
public/              UI de una sola página, sin build
```
