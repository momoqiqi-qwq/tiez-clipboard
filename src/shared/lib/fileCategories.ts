export interface FileCategory {
  id: string;
  name: string;
  extensions: string[];
  icon: string;
  visible: boolean;
}

export const parseFileExtensions = (value: string): string[] => [...new Set(
  value.toLowerCase().split(/[\s,;，；、]+/).map(part => part.replace(/^\*?\./, ""))
    .filter(part => /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*$/.test(part))
)];

export const DEFAULT_FILE_CATEGORIES: FileCategory[] = [
  ["excel", "Excel", "xls xlsx xlsm xlsb csv ods", "sheet"],
  ["word", "Word", "doc docx docm odt rtf", "document"],
  ["ppt", "PPT", "ppt pptx pps ppsx odp", "presentation"],
  ["pdf", "PDF", "pdf", "document"],
  ["audio", "", "mp3 wav flac aac m4a ogg wma opus", "audio"],
  ["archive", "", "zip rar 7z tar gz bz2 xz tgz tar.gz", "archive"],
  ["markdown", "Markdown", "md markdown mdx", "code"],
  ["python", "Python", "py pyw ipynb", "code"],
  ["html", "HTML", "html htm xhtml", "code"],
  ["exe", "EXE", "exe msi msix bat cmd", "app"],
  ["library", "DLL / PYD", "dll pyd so dylib", "app"],
  ["cpp", "C / C++", "c cpp cc cxx h hpp", "code"],
  ["disk", "ISO / IMG", "iso img dmg", "disk"]
].map(([id, name, extensions, icon]) => ({ id, name, extensions: parseFileExtensions(extensions), icon, visible: true }));

export function readFileCategories(value?: string): FileCategory[] {
  if (value === undefined) return DEFAULT_FILE_CATEGORIES.map(item => ({ ...item, extensions: [...item.extensions] }));
  try {
    const data: unknown = JSON.parse(value);
    if (!Array.isArray(data)) throw new Error("Invalid categories");
    const seen = new Set<string>();
    return data.filter((item): item is FileCategory => {
      if (!item || typeof item.id !== "string" || !item.id || seen.has(item.id)
        || typeof item.name !== "string" || typeof item.icon !== "string"
        || !Array.isArray(item.extensions) || !item.extensions.every((ext: unknown) => typeof ext === "string")) return false;
      seen.add(item.id);
      return true;
    }).map(item => ({ ...item, visible: item.visible !== false, extensions: parseFileExtensions(item.extensions.join(" ")) }))
      .filter(item => item.extensions.length > 0);
  } catch {
    return DEFAULT_FILE_CATEGORIES.map(item => ({ ...item, extensions: [...item.extensions] }));
  }
}

export function matchesFileExtensions(item: { content_type: string; content?: string }, extensions: readonly string[]): boolean {
  if (!extensions.length) return true;
  if (!["file", "image", "video"].includes(item.content_type)) return false;
  return (item.content || "").split(/\r?\n/).some(path => {
    const name = path.trim().replace(/^"|"$/g, "").split(/[\\/]/).pop()?.toLowerCase() || "";
    return extensions.some(ext => name.endsWith(`.${ext}`));
  });
}
