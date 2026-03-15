// Project manager — handles multi-file project state, persistence, and templates
import { BOARDS, DEFAULT_BOARD, getBoardTemplate } from './boards.js';

const STORAGE_KEY = 'daisy-gpt-project';
const PROJECTS_LIST_KEY = 'daisy-gpt-projects-list';

/**
 * Create a new project with default template for the given board.
 */
export function createProject(name = 'untitled', boardId = DEFAULT_BOARD) {
  const board = BOARDS[boardId] || BOARDS[DEFAULT_BOARD];
  const mainFile = 'main.cpp';
  return {
    name,
    board: boardId,
    activeFile: mainFile,
    openTabs: [mainFile],
    files: {
      [mainFile]: {
        content: getBoardTemplate(boardId),
        dirty: false,
      },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Add a file to a project. Returns the updated project.
 */
export function addFile(project, filePath, content = '') {
  if (project.files[filePath]) {
    throw new Error(`File "${filePath}" already exists`);
  }
  project.files[filePath] = { content, dirty: false };
  project.updatedAt = Date.now();
  return project;
}

/**
 * Delete a file from a project. Returns the updated project.
 */
export function deleteFile(project, filePath) {
  if (!project.files[filePath]) {
    throw new Error(`File "${filePath}" does not exist`);
  }
  if (Object.keys(project.files).length <= 1) {
    throw new Error('Cannot delete the last file');
  }
  delete project.files[filePath];
  project.openTabs = project.openTabs.filter(t => t !== filePath);
  if (project.activeFile === filePath) {
    project.activeFile = project.openTabs[0] || Object.keys(project.files)[0];
  }
  project.updatedAt = Date.now();
  return project;
}

/**
 * Rename a file in a project. Returns the updated project.
 */
export function renameFile(project, oldPath, newPath) {
  if (!project.files[oldPath]) {
    throw new Error(`File "${oldPath}" does not exist`);
  }
  if (project.files[newPath]) {
    throw new Error(`File "${newPath}" already exists`);
  }
  project.files[newPath] = project.files[oldPath];
  delete project.files[oldPath];
  project.openTabs = project.openTabs.map(t => t === oldPath ? newPath : t);
  if (project.activeFile === oldPath) {
    project.activeFile = newPath;
  }
  project.updatedAt = Date.now();
  return project;
}

/**
 * Update file content. Returns the updated project.
 */
export function updateFileContent(project, filePath, content) {
  if (!project.files[filePath]) {
    throw new Error(`File "${filePath}" does not exist`);
  }
  project.files[filePath].content = content;
  project.files[filePath].dirty = true;
  project.updatedAt = Date.now();
  return project;
}

/**
 * Get the content of the active file.
 */
export function getActiveFileContent(project) {
  const file = project.files[project.activeFile];
  return file ? file.content : '';
}

/**
 * Get all file paths in the project, sorted.
 */
export function getFilePaths(project) {
  return Object.keys(project.files).sort();
}

/**
 * Get all .cpp file paths (for compilation).
 */
export function getCppFiles(project) {
  return Object.entries(project.files)
    .filter(([path]) => path.endsWith('.cpp') || path.endsWith('.cc'))
    .map(([path, file]) => ({ path, content: file.content }));
}

/**
 * Get all files as a flat object (for compilation server).
 */
export function getAllFiles(project) {
  const result = {};
  for (const [path, file] of Object.entries(project.files)) {
    result[path] = file.content;
  }
  return result;
}

/**
 * Get a project summary string for AI context.
 */
export function getProjectSummary(project) {
  const board = BOARDS[project.board] || BOARDS[DEFAULT_BOARD];
  const filePaths = getFilePaths(project);
  let summary = `PROJECT: "${project.name}" | BOARD: ${board.name} (${board.className})\n`;
  summary += `FILES (${filePaths.length}):\n`;
  for (const path of filePaths) {
    const lines = project.files[path].content.split('\n').length;
    const active = path === project.activeFile ? ' [ACTIVE]' : '';
    summary += `  - ${path} (${lines} lines)${active}\n`;
  }
  return summary;
}

/**
 * Get full project context for LLM — all files with contents.
 */
export function getProjectContext(project) {
  const filePaths = getFilePaths(project);
  let context = '';
  for (const path of filePaths) {
    context += `--- ${path}\n\`\`\`cpp\n${project.files[path].content}\n\`\`\`\n\n`;
  }
  return context;
}

// ─── Persistence ────────────────────────────────────────────────

const PROJECT_PREFIX = 'daisy-gpt-proj-';

function projectKey(name) {
  return PROJECT_PREFIX + name;
}

/**
 * Save the current project to localStorage (also persists to the multi-project store).
 */
export function saveProject(project) {
  try {
    // Mark all files as clean on save
    for (const file of Object.values(project.files)) {
      file.dirty = false;
    }
    project.updatedAt = Date.now();

    // Save as the "current" project
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));

    // Also save to the multi-project store
    localStorage.setItem(projectKey(project.name), JSON.stringify(project));

    // Update the projects list index
    updateProjectsIndex(project);
  } catch (e) {
    console.error('Failed to save project:', e);
  }
}

/**
 * Save project under a new name. Returns the renamed project.
 */
export function saveProjectAs(project, newName) {
  if (!newName || !newName.trim()) throw new Error('Project name cannot be empty');
  newName = newName.trim();

  // Remove old entry if renaming
  if (project.name !== newName) {
    deleteProjectByName(project.name);
  }

  project.name = newName;
  saveProject(project);
  return project;
}

/**
 * Load the current project from localStorage.
 */
export function loadProject() {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    return JSON.parse(json);
  } catch (e) {
    console.error('Failed to load project:', e);
    return null;
  }
}

/**
 * Load a specific project by name from the multi-project store.
 */
export function loadProjectByName(name) {
  try {
    const json = localStorage.getItem(projectKey(name));
    if (!json) return null;
    return JSON.parse(json);
  } catch (e) {
    console.error('Failed to load project:', e);
    return null;
  }
}

/**
 * Delete a project by name from the multi-project store.
 */
export function deleteProjectByName(name) {
  try {
    localStorage.removeItem(projectKey(name));

    // Remove from index
    const list = loadProjectsList();
    const filtered = list.filter(p => p.name !== name);
    localStorage.setItem(PROJECTS_LIST_KEY, JSON.stringify(filtered));
  } catch (e) {
    console.error('Failed to delete project:', e);
  }
}

/**
 * Duplicate a project under a new name. Returns the new project.
 */
export function duplicateProject(project, newName) {
  const copy = JSON.parse(JSON.stringify(project));
  copy.name = newName;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  saveProject(copy);
  return copy;
}

/**
 * Rename a project. Returns the updated project.
 */
export function renameProject(project, newName) {
  if (!newName || !newName.trim()) throw new Error('Project name cannot be empty');
  newName = newName.trim();
  if (newName === project.name) return project;

  // Check if target name already exists
  const existing = loadProjectByName(newName);
  if (existing) throw new Error(`Project "${newName}" already exists`);

  const oldName = project.name;
  project.name = newName;
  project.updatedAt = Date.now();

  // Remove old storage key
  localStorage.removeItem(projectKey(oldName));

  // Save under new name
  saveProject(project);
  return project;
}

/**
 * Load the list of saved projects (metadata only).
 */
export function loadProjectsList() {
  try {
    return JSON.parse(localStorage.getItem(PROJECTS_LIST_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * Update the projects index with the given project's metadata.
 */
function updateProjectsIndex(project) {
  const list = loadProjectsList();
  const existing = list.findIndex(p => p.name === project.name);
  const entry = {
    name: project.name,
    board: project.board,
    fileCount: Object.keys(project.files).length,
    updatedAt: project.updatedAt,
  };
  if (existing >= 0) {
    list[existing] = entry;
  } else {
    list.unshift(entry);
  }
  if (list.length > 50) list.length = 50;
  localStorage.setItem(PROJECTS_LIST_KEY, JSON.stringify(list));
}

/**
 * Check if any files have unsaved changes.
 */
export function hasUnsavedChanges(project) {
  return Object.values(project.files).some(f => f.dirty);
}

/**
 * Migrate a legacy single-file state.code into a project.
 */
export function migrateFromLegacy(code, board = DEFAULT_BOARD) {
  const project = createProject('migrated-patch', board);
  if (code && code.trim()) {
    project.files['main.cpp'].content = code;
  }
  return project;
}
