import { createHttpServer } from './server';

const PORT = Number(process.env.PORT) || 4000;

const server = createHttpServer();

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
