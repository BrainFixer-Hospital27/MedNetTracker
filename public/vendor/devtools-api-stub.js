// Заглушка для @vue/devtools-api.
// Pinia импортирует её только ради интеграции с расширением Vue Devtools.
// В рабочем контуре расширения нет, а тянуть ради этого лишний пакет незачем.
export function setupDevtoolsPlugin() {}
export const now = () => Date.now();
