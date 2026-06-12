import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Save, FileCode, CheckCircle, AlertCircle, Folder, FolderOpen, ArrowLeft, ArrowUp } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import './EditorPane.css';

function getLanguageExtension(filePath) {
  if (!filePath) return [];
  const ext = filePath.split('.').pop().toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'ts':
    case 'tsx':
      return [javascript({ jsx: true, typescript: true })];
    case 'html':
      return [html()];
    case 'css':
      return [css()];
    case 'json':
      return [json()];
    case 'md':
    case 'markdown':
      return [markdown()];
    case 'py':
      return [python()];
    default:
      return [];
  }
}

function getLanguage(filePath) {
  if (!filePath) return 'text';
  const ext = filePath.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', json: 'json', md: 'markdown', css: 'css', html: 'html',
    sh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'toml', rs: 'rust',
    go: 'go', c: 'c', cpp: 'cpp', java: 'java', rb: 'ruby',
  };
  return map[ext] || 'text';
}

function TabBar({ tabs, activeTabPath, onTabSelect, onTabClose }) {
  return (
    <div className="editor-tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.path}
          className={`editor-tab ${tab.path === activeTabPath ? 'active' : ''} ${tab.isDirty ? 'dirty' : ''}`}
          onClick={() => onTabSelect(tab.path)}
          title={tab.path}
        >
          <FileCode size={12} className="tab-file-icon" />
          <span className="tab-name">{tab.name}</span>
          {tab.isDirty && <span className="dirty-dot" title="Unsaved changes" />}
          <button
            className="tab-close-btn"
            onClick={(e) => { e.stopPropagation(); onTabClose(tab.path); }}
            title="Close tab"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      {tabs.length === 0 && (
        <div className="editor-tab-empty-hint">No files open</div>
      )}
    </div>
  );
}

export default function EditorPane({ openFiles, activeFilePath, onTabSelect, onTabClose, onFileSave, onFileOpen, refreshTrigger }) {
  const [files, setFiles] = useState([]);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [currentDir, setCurrentDir] = useState('');
  const [dirHistory, setDirHistory] = useState([]);

  useEffect(() => {
    setCurrentDir('');
    setDirHistory([]);

    fetch('/api/workspaces')
      .then(res => res.json())
      .then(data => {
        setWorkspaceRoot(data.root || '');
      })
      .catch(() => {});

    fetch('/api/workspace/files')
      .then(res => res.json())
      .then(data => setFiles(data))
      .catch(() => {});
  }, [refreshTrigger]);

  // Local edit state per tab: path → content string
  const [editContents, setEditContents] = useState({});
  const [saveState, setSaveState] = useState({}); // path → 'saved' | 'error' | null

  const lastContentsRef = useRef({});

  // Seed or update edit content when tab files change or load
  useEffect(() => {
    openFiles.forEach(tab => {
      const prevContent = lastContentsRef.current[tab.path];
      const localContent = editContents[tab.path];
      
      if (localContent === undefined || tab.content !== prevContent) {
        setEditContents(prev => ({ ...prev, [tab.path]: tab.content }));
        lastContentsRef.current[tab.path] = tab.content;
      }
    });
    
    // Clean up closed files from tracking refs/state
    const openPaths = new Set(openFiles.map(f => f.path));
    Object.keys(lastContentsRef.current).forEach(p => {
      if (!openPaths.has(p)) {
        delete lastContentsRef.current[p];
      }
    });
  }, [openFiles]);

  // Normalise files to use '/' forward slashes
  const normalisedFiles = files.map(f => f.replace(/\\/g, '/'));

  // Get immediate children under currentDir
  const addedFolders = new Set();
  const addedFiles = new Set();

  normalisedFiles.forEach(file => {
    if (currentDir === '') {
      const parts = file.split('/');
      if (parts.length === 1) {
        addedFiles.add(file);
      } else {
        addedFolders.add(parts[0]);
      }
    } else {
      const prefix = currentDir + '/';
      if (file.startsWith(prefix)) {
        const remaining = file.slice(prefix.length);
        const parts = remaining.split('/');
        if (parts.length === 1) {
          addedFiles.add(file);
        } else {
          addedFolders.add(parts[0]);
        }
      }
    }
  });

  const displayFolders = Array.from(addedFolders).sort();
  const displayFiles = Array.from(addedFiles).sort();

  // Navigation handlers
  const handleFolderClick = (folderName) => {
    const nextDir = currentDir === '' ? folderName : `${currentDir}/${folderName}`;
    setDirHistory(prev => [...prev, currentDir]);
    setCurrentDir(nextDir);
  };

  const handleGoBack = () => {
    if (dirHistory.length === 0) return;
    const prevDir = dirHistory[dirHistory.length - 1];
    setDirHistory(prev => prev.slice(0, -1));
    setCurrentDir(prevDir);
  };

  const handleGoUp = () => {
    if (currentDir === '') return;
    setDirHistory(prev => [...prev, currentDir]);
    const parts = currentDir.split('/');
    if (parts.length === 1) {
      setCurrentDir('');
    } else {
      setCurrentDir(parts.slice(0, -1).join('/'));
    }
  };

  const activeTab = openFiles.find(t => t.path === activeFilePath);
  const currentContent = activeFilePath !== undefined ? (editContents[activeFilePath] ?? activeTab?.content ?? '') : '';
  const isDirty = activeTab && editContents[activeFilePath] !== undefined && editContents[activeFilePath] !== activeTab.content;

  const handleEditorChange = useCallback((value) => {
    if (!activeFilePath) return;
    setEditContents(prev => ({ ...prev, [activeFilePath]: value }));
  }, [activeFilePath]);

  const handleSave = useCallback(async () => {
    if (!activeFilePath) return;
    const content = editContents[activeFilePath] ?? activeTab?.content ?? '';
    try {
      await onFileSave(activeFilePath, content);
      setSaveState(prev => ({ ...prev, [activeFilePath]: 'saved' }));
      setTimeout(() => setSaveState(prev => ({ ...prev, [activeFilePath]: null })), 2000);
    } catch {
      setSaveState(prev => ({ ...prev, [activeFilePath]: 'error' }));
      setTimeout(() => setSaveState(prev => ({ ...prev, [activeFilePath]: null })), 3000);
    }
  }, [activeFilePath, editContents, activeTab, onFileSave]);

  // Ctrl+S / Cmd+S to save, or trigger via custom event
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    const customSaveHandler = () => {
      handleSave();
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('trigger-file-save', customSaveHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('trigger-file-save', customSaveHandler);
    };
  }, [handleSave]);

  // Mark tab as open/dirty based on local edits
  const tabsWithDirty = openFiles.map(t => ({
    ...t,
    isDirty: editContents[t.path] !== undefined && editContents[t.path] !== t.content,
  }));

  const sv = activeFilePath ? saveState[activeFilePath] : null;

  return (
    <div className="editor-pane-container">
      <div className="editor-view-section">
        <TabBar
          tabs={tabsWithDirty}
          activeTabPath={activeFilePath}
          onTabSelect={onTabSelect}
          onTabClose={onTabClose}
        />

        {activeTab ? (
          <div className="editor-body">
            <div className="editor-toolbar">
              <span className="editor-filepath" title={activeTab.path}>
                {activeTab.path}
              </span>
              <div className="editor-toolbar-actions">
                {sv === 'saved' && (
                  <span className="save-status saved"><CheckCircle size={13} /> Saved</span>
                )}
                {sv === 'error' && (
                  <span className="save-status error"><AlertCircle size={13} /> Save failed</span>
                )}
                <span className="editor-lang-badge">{getLanguage(activeTab.path)}</span>
                <button
                  className={`editor-save-btn ${isDirty ? 'dirty' : ''}`}
                  onClick={handleSave}
                  title="Save file (Ctrl+S)"
                >
                  <Save size={14} />
                  {isDirty ? 'Save*' : 'Save'}
                </button>
              </div>
            </div>

            <div className="editor-content-area">
              <CodeMirror
                value={currentContent}
                className="rich-editor"
                theme="dark"
                height="100%"
                extensions={getLanguageExtension(activeTab.path)}
                onChange={handleEditorChange}
              />
            </div>
          </div>
        ) : (
          <div className="editor-empty-state">
            <FileCode size={48} className="editor-empty-icon" />
            <p className="editor-empty-title">No file open</p>
            <p className="editor-empty-hint">
              Click a file in the workspace explorer below, or files modified by Qexow will open automatically.
            </p>
          </div>
        )}
      </div>

      <div className="editor-files-section">
        <div className="editor-files-header">
          <div className="header-left">
            <Folder size={15} />
            <span className="current-path">{currentDir === '' ? 'Workspace Root' : `Root / ${currentDir}`}</span>
          </div>
          <div className="header-right-nav">
            <button
              className="folder-nav-btn"
              disabled={dirHistory.length === 0}
              onClick={handleGoBack}
              title="Go back"
            >
              <ArrowLeft size={13} />
              <span>Back</span>
            </button>
            <button
              className="folder-nav-btn"
              disabled={currentDir === ''}
              onClick={handleGoUp}
              title="Go up"
            >
              <ArrowUp size={13} />
              <span>Up</span>
            </button>
          </div>
        </div>
        <div className="editor-files-list">
          {/* Folders */}
          {displayFolders.map(folder => (
            <div
              key={folder}
              className="editor-file-item folder"
              title={folder}
              onClick={() => handleFolderClick(folder)}
            >
              <FolderOpen size={14} className="folder-icon" />
              <span className="file-name">{folder}</span>
            </div>
          ))}

          {/* Files */}
          {displayFiles.map(file => (
            <div
              key={file}
              className="editor-file-item file"
              title={file}
              onClick={() => {
                if (onFileOpen) {
                  const sep = workspaceRoot.includes('\\') ? '\\' : '/';
                  const absPath = workspaceRoot
                    ? workspaceRoot.replace(/[\\/]+$/, '') + sep + file.replace(/\//g, sep)
                    : file;
                  onFileOpen(absPath);
                }
              }}
            >
              <FileCode size={14} className="file-icon" />
              <span className="file-name">{file.split('/').pop()}</span>
            </div>
          ))}

          {displayFolders.length === 0 && displayFiles.length === 0 && (
            <div className="no-files-hint">No items found in this directory</div>
          )}
        </div>
      </div>
    </div>
  );
}
