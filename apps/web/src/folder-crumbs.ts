/** One segment of Choose Folder's breadcrumb (#2956): its label and the folder it opens. */
export interface FolderCrumb {
  name: string;
  path: string;
}

/** The label of the crumb that stands for the machine's home folder. */
export const HOME_CRUMB = "Home";

interface SplitPath {
  separator: "/" | "\\";
  /** The root as written, ending in its separator ("/", "C:\", "\\server\share\"), or "" for a
   * path the runner returned without one. */
  root: string;
  names: string[];
}

/** A runner reports native paths, so a Windows machine's are `C:\Users\…` or `\\server\share\…`;
 * everything else, WSL distros included, uses `/`. */
function splitPath(path: string): SplitPath {
  const windows = /^[A-Za-z]:(?:\\|$)|^\\\\/.test(path) || (path.includes("\\") && !path.includes("/"));
  if (!windows) {
    return { separator: "/", root: path.startsWith("/") ? "/" : "", names: path.split("/").filter(Boolean) };
  }
  const root = /^\\\\[^\\]+\\[^\\]+\\?/.exec(path)?.[0] ?? /^[A-Za-z]:\\?/.exec(path)?.[0] ?? "";
  return {
    separator: "\\",
    root: root && !root.endsWith("\\") ? `${root}\\` : root,
    names: path.slice(root.length).split("\\").filter(Boolean),
  };
}

/**
 * The trail from the machine's home folder to `path`, the current folder last. A folder outside
 * home (above it, or another drive) gets the trail from its filesystem root instead, so every
 * ancestor stays one press away.
 */
export function folderCrumbs(path: string, home: string | null): FolderCrumb[] {
  const split = splitPath(path);
  const crumbs: FolderCrumb[] = split.root
    ? [{ name: split.root === "/" ? "/" : split.root.replace(/\\$/, ""), path: split.root }]
    : [];
  let current = split.root;
  for (const name of split.names) {
    current = !current || current.endsWith(split.separator) ? `${current}${name}` : `${current}${split.separator}${name}`;
    crumbs.push({ name, path: current });
  }
  if (home === null) return crumbs;
  const homeSplit = splitPath(home);
  const insideHome = homeSplit.separator === split.separator && homeSplit.root === split.root &&
    homeSplit.names.length <= split.names.length &&
    homeSplit.names.every((name, index) => split.names[index] === name);
  if (!insideHome) return crumbs;
  // The root crumb, when there is one, comes before the first name.
  const homeIndex = homeSplit.names.length - (split.root ? 0 : 1);
  if (homeIndex < 0) return crumbs;
  return [{ name: HOME_CRUMB, path: crumbs[homeIndex]!.path }, ...crumbs.slice(homeIndex + 1)];
}
