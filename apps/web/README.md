# Xsion - Discovery Platform MVP

A clean, minimal web application for automated website discovery, flow mapping, and issue detection.

## Features

- **Project Management**: Create and manage target websites
- **Discovery Runs**: Automated exploration of web applications
- **Flow Mapping**: Visual representation of user journeys with ReactFlow
- **Live Preview**: Embedded iframe preview of target websites
- **Screenshot Stream**: Real-time screenshot capture during discovery
- **Issue Reporting**: Comprehensive reports with detected issues

## Tech Stack

- **React 18** with TypeScript
- **Vite** for fast development and building
- **React Router** for navigation
- **Zustand** for state management
- **ReactFlow** for interactive flow diagrams
- **Zod** for runtime type validation
- **Lucide React** for icons
- **Plain CSS** with CSS variables for styling

## Getting Started

### Prerequisites

- Node.js 16+ and npm/yarn/pnpm

### Installation

1. Install dependencies:

```bash
npm install
```

2. Start the development server:

```bash
npm run dev
```

3. Open your browser and navigate to `http://localhost:5173`

### Build for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

### Preview Production Build

```bash
npm run preview
```

## Project Structure

```
src/
  app/                   # Application root and routing
    App.tsx
    routes.tsx
    layout/              # Shell, Topbar, Sidebar
  pages/                 # Page components
    ProjectsPage.tsx
    ProjectDetailPage.tsx
    DiscoveryPage.tsx
    RunsPage.tsx
    RunDetailPage.tsx
  components/
    ui/                  # Reusable UI components
    graph/               # Flow map components
    preview/             # Preview components
    runs/                # Run-specific components
  store/                 # Zustand state management
    useAppStore.ts
  api/                   # API client and types
    client.ts
    types.ts
    mock.ts              # Mock data for development
  styles/                # Global styles and theme
    global.css
    theme.css
```

## Current Implementation

This MVP uses **mock API data** for development. The mock API simulates network latency and provides realistic sample data. To integrate with a real backend:

1. Replace `src/api/mock.ts` with actual API calls
2. Update `src/api/client.ts` to use the real implementation
3. Keep the same interface defined in `src/api/types.ts`

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint

## Features Overview

### Projects
- Create new projects with target URLs
- View project details and history
- Start discovery runs from projects

### Discovery
- Configure and launch discovery runs
- Real-time progress tracking
- Live screenshot stream

### Flow Map
- Interactive visualization of page flows
- Node types: pages, actions, errors
- Animated edge transitions

### Reports
- Summary statistics
- Issue breakdown by severity
- Page-by-page analysis with screenshots

## License

MIT
