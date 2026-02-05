# Relay Manager

Sistema web empresarial para gestionar placas de reles Devantech y equipamiento industrial conectado.

**Autor:** Alejandro Avila Marcos
**Made with** :heart: **for dev team Valdepenas**

---

## Caracteristicas

- **Control de Reles** - Toggle on/off con sincronizacion en tiempo real
- **Gestion de Equipamiento** - CRUD completo con asignacion a placas
- **Sistema de Bloqueo** - Locks exclusivos temporales con expiracion automatica
- **Terminal Serie** - Emulacion xterm via WebSocket para acceso a placas Zynq
- **Control de Acceso (RBAC)** - Visibilidad de equipos filtrada por roles
- **Gestion de Usuarios/Roles** - Administracion completa con permisos admin

---

## Stack Tecnologico

| Capa | Tecnologia |
|------|------------|
| Frontend | Next.js 16 + React 19 + Tailwind CSS 4 + Radix UI |
| Backend | Next.js API Routes + Servidor HTTP/WebSocket custom |
| Base de datos | SQLite con Prisma 7 |
| Autenticacion | NextAuth 5 (JWT + Credentials) |
| Tiempo real | SSE (estados de reles/locks) + WebSocket (terminal serie) |
| Hardware | serialport (puertos serie) + HTTP XML (placas Devantech) |

---

## Requisitos Previos

- **Node.js** >= 18.x
- **pnpm** (recomendado) o npm
- Acceso a placas Devantech en la red local
- (Opcional) Puertos serie USB para terminales Zynq

---

## Instalacion

### 1. Clonar el repositorio

```bash
git clone https://github.com/tu-usuario/relay-manager.git
cd relay-manager
```

### 2. Instalar dependencias

```bash
pnpm install
# o con npm
npm install
```

### 3. Configurar variables de entorno

Copia el archivo de ejemplo y ajusta los valores:

```bash
cp .env.example .env.local
```

Edita `.env.local`:

```env
# Base de datos (SQLite por defecto)
DATABASE_URL="file:./prisma/dev.db"

# Autenticacion - IMPORTANTE: Genera un secreto unico
# Ejecuta: openssl rand -base64 32
AUTH_SECRET="tu-secreto-super-seguro-aqui"

# URL base de la aplicacion
AUTH_URL="http://localhost:3000"

# WebSocket para terminales serial (opcional)
NEXT_PUBLIC_WS_HOST=          # Dejar vacio para desarrollo local
NEXT_PUBLIC_WS_PORT=3001
NEXT_PUBLIC_WS_PROTOCOL=      # ws o wss (auto-detecta si vacio)
```

### 4. Inicializar la base de datos

```bash
# Generar cliente Prisma
pnpm prisma generate

# Crear/migrar base de datos
pnpm prisma db push
```

### 5. Crear usuario administrador inicial

Puedes usar Prisma Studio para crear el primer usuario:

```bash
pnpm prisma studio
```

La contrasena debe estar hasheada con bcrypt. Puedes usar esta herramienta online: https://bcrypt-generator.com/ o ejecutar:

```bash
node -e "const bcrypt = require('bcryptjs'); console.log(bcrypt.hashSync('tu-password', 10));"
```

Luego en Prisma Studio, crea un usuario con:
- `email`: tu email
- `password`: el hash generado
- `name`: tu nombre
- `isAdmin`: true

---

## Ejecucion

### Desarrollo

```bash
pnpm dev
```

Esto inicia:
- Servidor Next.js en `http://localhost:3000`
- Servidor WebSocket en `ws://localhost:3001`
- Sincronizacion periodica de placas de reles (cada 5 segundos)

### Produccion

```bash
# Compilar
pnpm build

# Ejecutar
pnpm start
```

---

## Scripts Disponibles

| Script | Descripcion |
|--------|-------------|
| `pnpm dev` | Inicia servidor de desarrollo (HTTP + WebSocket) |
| `pnpm dev:next` | Inicia solo Next.js (sin WebSocket) |
| `pnpm build` | Compila la aplicacion para produccion |
| `pnpm start` | Ejecuta la aplicacion compilada |
| `pnpm lint` | Ejecuta ESLint |
| `pnpm prisma studio` | Abre interfaz visual de base de datos |
| `pnpm prisma db push` | Sincroniza esquema con base de datos |
| `pnpm prisma generate` | Genera cliente Prisma |

---

## Estructura del Proyecto

```
relay-manager/
├── src/
│   ├── app/              # Rutas Next.js (pages + API)
│   │   ├── api/          # Endpoints REST y SSE
│   │   ├── login/        # Pagina de login
│   │   └── (dashboard)/  # Rutas protegidas del dashboard
│   ├── actions/          # Server Actions (CRUD)
│   ├── components/       # Componentes React
│   │   ├── ui/           # Componentes base (Radix UI)
│   │   ├── layout/       # Layout components
│   │   ├── boards/       # Visualizacion de placas
│   │   ├── equipments/   # UI de equipamiento
│   │   └── terminal/     # Terminal serie
│   ├── lib/              # Servicios core
│   │   ├── relay-service.ts    # Control de reles
│   │   ├── serial-manager.ts   # Gestion puertos serie
│   │   ├── relay-events.ts     # Event emitter SSE
│   │   ├── auth.ts             # Config NextAuth
│   │   └── prisma.ts           # Cliente Prisma
│   ├── hooks/            # Custom React hooks
│   └── types/            # TypeScript definitions
├── prisma/
│   └── schema.prisma     # Esquema de base de datos
├── server.ts             # Servidor HTTP + WebSocket
└── package.json
```

---

## Configuracion de Hardware

### Placas de Reles Devantech

Las placas se comunican via HTTP XML. Cada placa necesita:
- IP estatica en la red local
- Acceso sin autenticacion (o configurar credenciales)

Protocolo:
- Estado: `GET http://<ip>/index.xml`
- Toggle: `GET http://<ip>/dscript.cgi?V20944=<relay_num>`

### Puertos Serie (Zynq)

Los puertos serie se identifican por su ID USB:
```
/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_XXXXX-if00-port0
```

Configuracion por defecto:
- Baud rate: 115200
- Data bits: 8
- Stop bits: 1
- Parity: None

---

## API Endpoints

### Autenticacion
- `POST /api/auth/callback/credentials` - Login
- `GET /api/auth/session` - Obtener sesion

### Reles
- `POST /api/relay` - Toggle rele `{ boardId, relayIndex }`
- `GET /api/relay?boardId=xxx` - Estado de placa
- `GET /api/relay/state` - Estado de todas las placas
- `GET /api/relay/ping?boardId=xxx` - Verificar conectividad
- `GET /api/relay/events` - Stream SSE (estados y locks)

### WebSocket
- `ws://localhost:3001?id=<serialId>&baudRate=<rate>` - Terminal serie

---

## Configuracion de Produccion

### Variables de Entorno

```env
# Produccion
NODE_ENV=production
DATABASE_URL="file:./prisma/prod.db"
AUTH_SECRET="<secreto-generado-con-openssl>"
AUTH_URL="https://tu-dominio.com"

# WebSocket (ajustar segun tu servidor)
NEXT_PUBLIC_WS_HOST=tu-dominio.com
NEXT_PUBLIC_WS_PORT=3001
NEXT_PUBLIC_WS_PROTOCOL=wss
```

### Permisos de Puertos Serie

En Linux, el usuario que ejecuta la aplicacion necesita acceso a los puertos serie:

```bash
# Anadir usuario al grupo dialout
sudo usermod -a -G dialout $USER

# O dar permisos al puerto especifico
sudo chmod 666 /dev/ttyUSB0
```

---

## Licencia

Este proyecto esta licenciado bajo la **MIT License** - ver el archivo [LICENSE](LICENSE) para mas detalles.

**Atribucion requerida:** Si usas este proyecto, debes mantener los creditos al autor original (Alejandro Avila Marcos).

---

## Autor

**Alejandro Avila Marcos**

Made with :heart: for dev team Valdepenas
