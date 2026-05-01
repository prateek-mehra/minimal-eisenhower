import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { createPortal } from "react-dom"
import {
  DndContext,
  closestCenter,
  useDroppable,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"

import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable"

import { CSS } from "@dnd-kit/utilities"

const USER_KEY = "eisenhower_google_user_v1"
const TASKS_STORAGE_PREFIX = "eisenhower_tasks_v2"
const TOKEN_STORAGE_PREFIX = "eisenhower_drive_token_v1"
const GUEST_NAME_KEY = "eisenhower_guest_name_v1"
const GUEST_EMAIL = "__guest__"
const DEFAULT_GUEST_NAME = "Guest"

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata"
const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files"
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files"
const SYNC_FILE_NAME = "eisenhower-tasks.json"

const QUADRANTS = [
  {
    id: "UI",
    title: "Do First",
    subtitle: "Urgent & Important",
    tone: "dominant",
  },
  {
    id: "NI",
    title: "Schedule",
    subtitle: "Not Urgent & Important",
    tone: "balanced",
  },
  {
    id: "UN",
    title: "Delegate",
    subtitle: "Urgent & Not Important",
    tone: "balanced",
  },
  {
    id: "NN",
    title: "Eliminate",
    subtitle: "Not Urgent & Not Important",
    tone: "muted",
  },
]

const VALID_QUADRANTS = new Set(QUADRANTS.map(q => q.id))

const generateId = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `task_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

const getGuestName = (value) => {
  const name = typeof value === "string" ? value.trim() : ""
  return name || DEFAULT_GUEST_NAME
}

const createGuestUser = (name) => ({
  mode: "guest",
  name: getGuestName(name),
  email: GUEST_EMAIL,
})

const getUserTasksStorageKey = (email) =>
  `${TASKS_STORAGE_PREFIX}:${(email || "").toLowerCase()}`

const getUserTokenStorageKey = (email) =>
  `${TOKEN_STORAGE_PREFIX}:${(email || "").toLowerCase()}`

const normalizeSubtask = (subtask, fallbackOrder = 0) => ({
  id: subtask?.id || generateId(),
  title: typeof subtask?.title === "string" ? subtask.title : "",
  url: typeof subtask?.url === "string" ? subtask.url : "",
  completed: Boolean(subtask?.completed),
  order: Number.isFinite(subtask?.order) ? subtask.order : fallbackOrder,
  updatedAt: Number.isFinite(subtask?.updatedAt) ? subtask.updatedAt : 0,
})

const normalizeSubtasks = (rawSubtasks) => {
  if (!Array.isArray(rawSubtasks)) return []
  return rawSubtasks
    .map((subtask, index) => normalizeSubtask(subtask, index))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      return a.id.localeCompare(b.id)
    })
}

const normalizeTask = (task, fallbackOrder = 0) => {
  const safeQuadrant = VALID_QUADRANTS.has(task?.quadrant) ? task.quadrant : "UI"
  return {
    id: task?.id || generateId(),
    title: typeof task?.title === "string" ? task.title : "",
    url: typeof task?.url === "string" ? task.url : "",
    quadrant: safeQuadrant,
    completed: Boolean(task?.completed),
    subtasks: normalizeSubtasks(task?.subtasks),
    order: Number.isFinite(task?.order) ? task.order : fallbackOrder,
    updatedAt: Number.isFinite(task?.updatedAt) ? task.updatedAt : 0,
  }
}

const normalizeTasks = (rawTasks) => {
  if (!Array.isArray(rawTasks)) return []
  return rawTasks.map((task, index) => normalizeTask(task, index))
}

const getLatestUpdate = (taskList) => {
  if (!taskList.length) return 0
  return taskList.reduce(
    (max, task) =>
      Math.max(
        max,
        task.updatedAt || 0,
        ...normalizeSubtasks(task.subtasks).map(subtask => subtask.updatedAt || 0)
      ),
    0
  )
}

const toSignature = (taskList) =>
  JSON.stringify(
    [...taskList]
      .map(task => normalizeTask(task))
      .sort((a, b) => {
        if (a.quadrant !== b.quadrant) return a.quadrant.localeCompare(b.quadrant)
        if (a.order !== b.order) return a.order - b.order
        return a.id.localeCompare(b.id)
      })
  )

const DESKTOP_MEDIA_QUERY = "(min-width: 768px)"

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined") return false
    return window.matchMedia(DESKTOP_MEDIA_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === "undefined") return undefined

    const media = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const handleChange = () => setIsDesktop(media.matches)
    handleChange()

    if (media.addEventListener) {
      media.addEventListener("change", handleChange)
      return () => media.removeEventListener("change", handleChange)
    }

    media.addListener(handleChange)
    return () => media.removeListener(handleChange)
  }, [])

  return isDesktop
}

export default function App() {
  const [tasks, setTasks] = useState([])
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem(USER_KEY)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })
  const [guestName, setGuestName] = useState(() => {
    try {
      return getGuestName(localStorage.getItem(GUEST_NAME_KEY))
    } catch {
      return DEFAULT_GUEST_NAME
    }
  })

  const googleButtonRef = useRef(null)
  const tokenClientRef = useRef(null)
  const tokenRequestRef = useRef(null)
  const syncTimerRef = useRef(null)
  const fileIdRef = useRef(null)
  const syncingRef = useRef(false)
  const syncInitializedRef = useRef(false)
  const skipNextTasksPersistRef = useRef(false)
  const lastSyncedSignatureRef = useRef(toSignature([]))

  const [googleReady, setGoogleReady] = useState(false)
  const [accessToken, setAccessToken] = useState(null)
  const [tokenExpiry, setTokenExpiry] = useState(0)
  const [syncStatus, setSyncStatus] = useState("idle")
  const [syncError, setSyncError] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const isDesktop = useIsDesktop()

  const isGuest = user?.mode === "guest"
  const userEmail = user?.email || ""
  const storageIdentity = isGuest ? GUEST_EMAIL : userEmail
  const hasClientId = Boolean(GOOGLE_CLIENT_ID)
  const helperText = isDesktop
    ? "Tap the task prompt to add, tap a task to show or hide subtasks, drag a task to move it, and use the side buttons to complete or delete."
    : "Tap the task prompt to add, drag by the grip to reorder, swipe right to complete, and swipe left to delete."

  const sortedTasks = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        if (a.quadrant !== b.quadrant) return a.quadrant.localeCompare(b.quadrant)
        if (a.order !== b.order) return a.order - b.order
        return a.id.localeCompare(b.id)
      }),
    [tasks]
  )

  useEffect(() => {
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user))
    } else {
      localStorage.removeItem(USER_KEY)
    }
  }, [user])

  useEffect(() => {
    localStorage.setItem(GUEST_NAME_KEY, getGuestName(guestName))
  }, [guestName])

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) {
        setMenuOpen(false)
      }
    }

    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [menuOpen])

  useEffect(() => {
    if (!storageIdentity) {
      setTasks([])
      setAccessToken(null)
      setTokenExpiry(0)
      skipNextTasksPersistRef.current = false
      lastSyncedSignatureRef.current = toSignature([])
      syncInitializedRef.current = false
      fileIdRef.current = null
      return
    }

    try {
      const key = getUserTasksStorageKey(storageIdentity)
      const stored = localStorage.getItem(key)
      const parsed = stored ? JSON.parse(stored) : []
      const normalized = normalizeTasks(parsed)
      skipNextTasksPersistRef.current = true
      setTasks(normalized)
      lastSyncedSignatureRef.current = toSignature(normalized)
    } catch {
      skipNextTasksPersistRef.current = true
      setTasks([])
      lastSyncedSignatureRef.current = toSignature([])
    }

    syncInitializedRef.current = false
    fileIdRef.current = null
  }, [storageIdentity])

  useEffect(() => {
    if (!userEmail || isGuest) {
      setAccessToken(null)
      setTokenExpiry(0)
      return
    }
    try {
      const key = getUserTokenStorageKey(userEmail)
      const stored = localStorage.getItem(key)
      if (!stored) {
        setAccessToken(null)
        setTokenExpiry(0)
        return
      }
      const parsed = JSON.parse(stored)
      const expiresAt = Number(parsed?.tokenExpiry || 0)
      if (parsed?.accessToken && Date.now() < expiresAt - 60_000) {
        setAccessToken(parsed.accessToken)
        setTokenExpiry(expiresAt)
      } else {
        localStorage.removeItem(key)
        setAccessToken(null)
        setTokenExpiry(0)
      }
    } catch {
      setAccessToken(null)
      setTokenExpiry(0)
    }
  }, [isGuest, userEmail])

  useEffect(() => {
    if (!userEmail || isGuest) return
    const key = getUserTokenStorageKey(userEmail)
    if (accessToken && tokenExpiry) {
      localStorage.setItem(
        key,
        JSON.stringify({
          accessToken,
          tokenExpiry,
        })
      )
    } else {
      localStorage.removeItem(key)
    }
  }, [accessToken, isGuest, tokenExpiry, userEmail])

  useEffect(() => {
    if (!storageIdentity) return
    if (skipNextTasksPersistRef.current) {
      skipNextTasksPersistRef.current = false
      return
    }
    const key = getUserTasksStorageKey(storageIdentity)
    localStorage.setItem(key, JSON.stringify(tasks))
  }, [storageIdentity, tasks])

  const renderGoogleButton = useCallback(() => {
    if (!window.google?.accounts?.id) return
    if (!googleButtonRef.current) return
    googleButtonRef.current.innerHTML = ""
    window.google.accounts.id.renderButton(googleButtonRef.current, {
      theme: "outline",
      size: "large",
      text: "continue_with",
      width: 260,
    })
  }, [])

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return
    if (typeof window === "undefined") return

    const existing = document.querySelector(
      'script[src="https://accounts.google.com/gsi/client"]'
    )

    const load = () => {
      if (!window.google?.accounts?.id) return

      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => {
          const profile = decodeJwt(response.credential)
          setUser({
            name: profile.name,
            email: profile.email,
            picture: profile.picture,
          })
        },
      })

      if (window.google?.accounts?.oauth2) {
        tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: DRIVE_SCOPE,
          callback: (response) => {
            if (response?.error) {
              if (tokenRequestRef.current) {
                tokenRequestRef.current.reject(new Error(response.error))
                tokenRequestRef.current = null
              }
              return
            }

            if (response?.access_token) {
              const expiresInMs = (response.expires_in || 0) * 1000
              setAccessToken(response.access_token)
              setTokenExpiry(Date.now() + expiresInMs)
              if (tokenRequestRef.current) {
                tokenRequestRef.current.resolve(response.access_token)
                tokenRequestRef.current = null
              }
            }
          },
        })
      }

      renderGoogleButton()
      setGoogleReady(true)
    }

    if (existing) {
      if (window.google?.accounts?.id) {
        load()
      } else {
        existing.addEventListener("load", load, { once: true })
      }
      return
    }

    const script = document.createElement("script")
    script.src = "https://accounts.google.com/gsi/client"
    script.async = true
    script.defer = true
    script.onload = load
    document.head.appendChild(script)
  }, [renderGoogleButton])

  const requestAccessToken = useCallback(({ prompt }) => {
    if (!tokenClientRef.current) return Promise.resolve(null)
    if (tokenRequestRef.current) return tokenRequestRef.current.promise

    let resolve = () => {}
    let reject = () => {}
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })

    tokenRequestRef.current = { resolve, reject, promise }
    tokenClientRef.current.requestAccessToken({ prompt })

    return promise
  }, [])

  const ensureAccessToken = useCallback(async ({ interactive } = {}) => {
    const isValid =
      accessToken && tokenExpiry && Date.now() < tokenExpiry - 60_000
    if (isValid) return accessToken
    if (!tokenClientRef.current) return null

    try {
      return await requestAccessToken({ prompt: interactive ? "consent" : "none" })
    } catch {
      return null
    }
  }, [accessToken, tokenExpiry, requestAccessToken])

  const driveFetch = useCallback(async (url, { method = "GET", token, body, headers } = {}) => {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(headers || {}),
      },
      body,
    })

    if (response.status === 204) return null
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || `Drive API error: ${response.status}`)
    }

    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("application/json")) {
      return response.json()
    }
    return response.text()
  }, [])

  const findRemoteFileId = useCallback(async (token) => {
    if (fileIdRef.current) return fileIdRef.current

    const query = encodeURIComponent(
      `name='${SYNC_FILE_NAME}' and 'appDataFolder' in parents and trashed=false`
    )
    const url = `${DRIVE_FILES_API}?spaces=appDataFolder&fields=files(id)&pageSize=1&q=${query}`
    const data = await driveFetch(url, { token })
    const id = data?.files?.[0]?.id || null
    fileIdRef.current = id
    return id
  }, [driveFetch])

  const readRemoteTasks = useCallback(async (token) => {
    const id = await findRemoteFileId(token)
    if (!id) return { exists: false, tasks: [] }

    const data = await driveFetch(`${DRIVE_FILES_API}/${id}?alt=media`, { token })
    return {
      exists: true,
      tasks: normalizeTasks(data?.tasks),
    }
  }, [findRemoteFileId, driveFetch])

  const writeRemoteTasks = useCallback(async (token, taskList) => {
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      tasks: normalizeTasks(taskList),
    }

    const existingId = await findRemoteFileId(token)

    if (existingId) {
      await driveFetch(`${DRIVE_UPLOAD_API}/${existingId}?uploadType=media`, {
        method: "PATCH",
        token,
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
        },
      })
      return
    }

    const boundary = `batch_${Math.random().toString(16).slice(2)}`
    const metadata = {
      name: SYNC_FILE_NAME,
      parents: ["appDataFolder"],
      mimeType: "application/json",
    }

    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(payload),
      `--${boundary}--`,
      "",
    ].join("\r\n")

    const created = await driveFetch(
      `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id`,
      {
        method: "POST",
        token,
        body,
        headers: {
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
      }
    )

    if (created?.id) {
      fileIdRef.current = created.id
    }
  }, [findRemoteFileId, driveFetch])

  const pushTasksToCloud = useCallback(async (nextTasks) => {
    if (syncingRef.current) return

    syncingRef.current = true
    setSyncStatus("syncing")
    setSyncError("")

    try {
      const token = await ensureAccessToken({ interactive: false })
      if (!token) throw new Error("No token")

      await writeRemoteTasks(token, nextTasks)
      lastSyncedSignatureRef.current = toSignature(nextTasks)
      setSyncStatus("ready")
    } catch {
      setSyncStatus("error")
      setSyncError("Changes saved locally. Cloud sync will retry.")
    } finally {
      syncingRef.current = false
    }
  }, [ensureAccessToken, writeRemoteTasks])

  const syncFromCloud = useCallback(async ({ interactive } = {}) => {
    if (!userEmail || !googleReady || !hasClientId) return

    setSyncError("")
    setSyncStatus("syncing")

    const token = await ensureAccessToken({ interactive: Boolean(interactive) })
    if (!token) {
      setSyncStatus("idle")
      if (interactive) {
        setSyncError("Cloud sync authorization was not granted.")
      }
      return
    }

    try {
      const remote = await readRemoteTasks(token)

      const key = getUserTasksStorageKey(userEmail)
      const localStored = localStorage.getItem(key)
      const local = normalizeTasks(localStored ? JSON.parse(localStored) : [])
      const localSig = toSignature(local)
      const remoteSig = toSignature(remote.tasks)

      if (remote.exists) {
        if (remoteSig !== localSig) {
          if (getLatestUpdate(remote.tasks) >= getLatestUpdate(local)) {
            setTasks(remote.tasks)
            lastSyncedSignatureRef.current = remoteSig
          } else {
            await writeRemoteTasks(token, local)
            lastSyncedSignatureRef.current = localSig
          }
        } else {
          lastSyncedSignatureRef.current = localSig
        }
      } else if (local.length > 0) {
        await writeRemoteTasks(token, local)
        lastSyncedSignatureRef.current = localSig
      } else {
        lastSyncedSignatureRef.current = toSignature([])
      }

      syncInitializedRef.current = true
      setSyncStatus("ready")
      setSyncError("")
    } catch {
      setSyncStatus("error")
      setSyncError("Unable to sync tasks from cloud.")
    }
  }, [
    userEmail,
    googleReady,
    hasClientId,
    ensureAccessToken,
    readRemoteTasks,
    writeRemoteTasks,
  ])

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return
    if (!googleReady) return
    renderGoogleButton()
  }, [googleReady, user, renderGoogleButton])

  useEffect(() => {
    if (isGuest || !userEmail || !googleReady || !hasClientId) return
    syncFromCloud({ interactive: false })
  }, [googleReady, hasClientId, isGuest, syncFromCloud, userEmail])

  useEffect(() => {
    if (!syncInitializedRef.current || isGuest || !userEmail || !hasClientId) return

    const currentSignature = toSignature(tasks)
    if (currentSignature === lastSyncedSignatureRef.current) return

    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current)
    }

    syncTimerRef.current = setTimeout(() => {
      pushTasksToCloud(tasks)
    }, 700)

    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current)
      }
    }
  }, [hasClientId, isGuest, pushTasksToCloud, tasks, userEmail])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    })
  )

  const addTask = (title, quadrant) => {
    if (!title.trim()) return

    setTasks(prev => {
      const now = Date.now()
      const newTask = {
        id: generateId(),
        title,
        url: "",
        quadrant,
        completed: false,
        subtasks: [],
        order: prev.filter(t => t.quadrant === quadrant).length,
        updatedAt: now,
      }
      return [...prev, newTask]
    })
  }

  const toggleTask = (id) => {
    setTasks(prev =>
      prev.map(t =>
        t.id === id ? { ...t, completed: !t.completed, updatedAt: Date.now() } : t
      )
    )
  }

  const updateTaskTitle = (id, title) => {
    const nextTitle = title.trim()
    if (!nextTitle) return

    setTasks(prev =>
      prev.map(task =>
        task.id === id
          ? { ...task, title: nextTitle, updatedAt: Date.now() }
          : task
      )
    )
  }

  const updateTaskUrl = (id, url) => {
    setTasks(prev =>
      prev.map(task =>
        task.id === id
          ? { ...task, url: url.trim(), updatedAt: Date.now() }
          : task
      )
    )
  }

  const addSubtask = (taskId, title) => {
    if (!title.trim()) return

    setTasks(prev =>
      prev.map(task => {
        if (task.id !== taskId) return task

        const subtasks = normalizeSubtasks(task.subtasks)
        const now = Date.now()
        return {
          ...task,
          subtasks: [
            ...subtasks,
            {
              id: generateId(),
              title: title.trim(),
              completed: false,
              order: subtasks.length,
              updatedAt: now,
            },
          ],
          updatedAt: now,
        }
      })
    )
  }

  const toggleSubtask = (taskId, subtaskId) => {
    setTasks(prev =>
      prev.map(task => {
        if (task.id !== taskId) return task

        const now = Date.now()
        return {
          ...task,
          subtasks: normalizeSubtasks(task.subtasks).map(subtask =>
            subtask.id === subtaskId
              ? { ...subtask, completed: !subtask.completed, updatedAt: now }
              : subtask
          ),
          updatedAt: now,
        }
      })
    )
  }

  const updateSubtaskTitle = (taskId, subtaskId, title) => {
    const nextTitle = title.trim()
    if (!nextTitle) return

    setTasks(prev =>
      prev.map(task => {
        if (task.id !== taskId) return task

        const now = Date.now()
        return {
          ...task,
          subtasks: normalizeSubtasks(task.subtasks).map(subtask =>
            subtask.id === subtaskId
              ? { ...subtask, title: nextTitle, updatedAt: now }
              : subtask
          ),
          updatedAt: now,
        }
      })
    )
  }

  const updateSubtaskUrl = (taskId, subtaskId, url) => {
    setTasks(prev =>
      prev.map(task => {
        if (task.id !== taskId) return task

        const now = Date.now()
        return {
          ...task,
          subtasks: normalizeSubtasks(task.subtasks).map(subtask =>
            subtask.id === subtaskId
              ? { ...subtask, url: url.trim(), updatedAt: now }
              : subtask
          ),
          updatedAt: now,
        }
      })
    )
  }

  const deleteSubtask = (taskId, subtaskId) => {
    setTasks(prev =>
      prev.map(task => {
        if (task.id !== taskId) return task

        const now = Date.now()
        return {
          ...task,
          subtasks: normalizeSubtasks(task.subtasks)
            .filter(subtask => subtask.id !== subtaskId)
            .map((subtask, index) => ({ ...subtask, order: index, updatedAt: now })),
          updatedAt: now,
        }
      })
    )
  }

  const deleteTask = (id) => {
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  const clearCompleted = () => {
    setTasks(prev => {
      const now = Date.now()
      return prev
        .filter(task => !task.completed)
        .map(task => {
          const activeSubtasks = normalizeSubtasks(task.subtasks).filter(
            subtask => !subtask.completed
          )

          if (activeSubtasks.length === normalizeSubtasks(task.subtasks).length) {
            return task
          }

          return {
            ...task,
            subtasks: activeSubtasks.map((subtask, index) => ({
              ...subtask,
              order: index,
              updatedAt: now,
            })),
            updatedAt: now,
          }
        })
    })
  }

  const reorderTasks = (quadrantTasks, from, to) => {
    const reordered = arrayMove(quadrantTasks, from, to)

    const now = Date.now()
    const updated = reordered.map((task, index) => ({
      ...task,
      order: index,
      updatedAt: now,
    }))

    setTasks(prev => {
      const quadrantId = quadrantTasks[0].quadrant
      const others = prev.filter(t => t.quadrant !== quadrantId)
      return [...others, ...updated]
    })
  }

  const handleDragEnd = ({ active, over }) => {
    if (!over) return

    const activeTask = tasks.find(t => t.id === active.id)
    if (!activeTask) return

    const sourceQuadrant = activeTask.quadrant
    const targetQuadrant = over.data?.current?.quadrant ?? sourceQuadrant

    if (sourceQuadrant === targetQuadrant) {
      const quadrantTasks = tasks
        .filter(t => t.quadrant === sourceQuadrant)
        .sort((a, b) => a.order - b.order)

      const oldIndex = quadrantTasks.findIndex(t => t.id === active.id)
      const newIndex = quadrantTasks.findIndex(t => t.id === over.id)

      if (oldIndex !== newIndex) {
        reorderTasks(quadrantTasks, oldIndex, newIndex)
      }
      return
    }

    setTasks(prev => {
      const sourceTasks = prev
        .filter(t => t.quadrant === sourceQuadrant && t.id !== active.id)
        .sort((a, b) => a.order - b.order)
        .map((t, i) => ({ ...t, order: i, updatedAt: Date.now() }))

      const targetTasks = prev
        .filter(t => t.quadrant === targetQuadrant)
        .sort((a, b) => a.order - b.order)

      const movedTask = {
        ...activeTask,
        quadrant: targetQuadrant,
        order: targetTasks.length,
        updatedAt: Date.now(),
      }

      return [
        ...prev.filter(
          t => t.quadrant !== sourceQuadrant && t.quadrant !== targetQuadrant
        ),
        ...sourceTasks,
        ...targetTasks,
        movedTask,
      ]
    })
  }

  if (!user) {
    return (
      <SignInScreen
        googleButtonRef={googleButtonRef}
        googleReady={googleReady}
        hasClientId={hasClientId}
        guestName={guestName}
        onGuestNameChange={setGuestName}
        onContinueAsGuest={(name) => {
          const nextGuestName = getGuestName(name)
          setGuestName(nextGuestName)
          setUser(createGuestUser(nextGuestName))
          setSyncStatus("idle")
          setSyncError("")
        }}
      />
    )
  }

  return (
    <div className="min-h-[100dvh] bg-[linear-gradient(180deg,_#f8fafc_0%,_#eef2f7_100%)] px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:p-6 md:h-[100dvh] md:overflow-hidden">
      <div className="mx-auto w-full max-w-6xl md:flex md:h-full md:flex-col">
        <div className="sticky top-0 z-10 -mx-4 mb-4 bg-[linear-gradient(180deg,_rgba(248,250,252,0.96)_0%,_rgba(248,250,252,0.82)_100%)] px-4 pb-3 pt-4 backdrop-blur sm:static sm:mx-0 sm:mb-6 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0 md:shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 sm:text-2xl">
                Eisenhower Matrix
              </h1>
              <p className="text-xs text-gray-500 sm:text-sm">
                {helperText}
              </p>
              {!isGuest && syncError && <p className="mt-2 text-xs text-red-500">{syncError}</p>}
              {!isGuest && (
                <div className="mt-3 flex items-center gap-2 sm:hidden">
                  <span className="rounded-full bg-white/75 px-3 py-1 text-[11px] text-gray-500 shadow-sm">
                    {syncStatus === "syncing"
                      ? "Syncing..."
                      : syncStatus === "ready"
                        ? "Synced"
                        : "Local only"}
                  </span>

                  {syncStatus !== "ready" && (
                    <button
                      onClick={() => syncFromCloud({ interactive: true })}
                      className="rounded-full bg-white px-3 py-2 text-xs text-gray-600 shadow-sm transition hover:bg-gray-50"
                    >
                      Enable cloud sync
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {!isGuest && (
                <div className="hidden items-center gap-2 sm:flex">
                  <span className="rounded-full bg-white/75 px-3 py-1 text-[11px] text-gray-500 shadow-sm">
                    {syncStatus === "syncing"
                      ? "Syncing..."
                      : syncStatus === "ready"
                        ? "Synced"
                        : "Local only"}
                  </span>

                  {syncStatus !== "ready" && (
                    <button
                      onClick={() => syncFromCloud({ interactive: true })}
                      className="rounded-full bg-white px-3 py-2 text-xs text-gray-600 shadow-sm transition hover:bg-gray-50"
                    >
                      Enable cloud sync
                    </button>
                  )}
                </div>
              )}

              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setMenuOpen(open => !open)}
                  className="grid h-10 w-10 place-items-center rounded-full bg-white/90 text-sm font-semibold text-gray-700 shadow-sm transition hover:bg-white"
                  aria-label="Open menu"
                >
                  {user.name.slice(0, 1).toUpperCase()}
                </button>

                {menuOpen && (
                  <div className="absolute right-0 top-12 z-20 min-w-48 rounded-2xl bg-white p-2 shadow-[0_18px_40px_rgba(15,23,42,0.12)]">
                    <button
                      onClick={() => {
                        clearCompleted()
                        setMenuOpen(false)
                      }}
                      className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-50"
                    >
                      Clear completed
                    </button>
                    <button
                      onClick={() => {
                        if (!isGuest && accessToken && window.google?.accounts?.oauth2?.revoke) {
                          window.google.accounts.oauth2.revoke(accessToken, () => {})
                        }
                        setUser(null)
                        setAccessToken(null)
                        setTokenExpiry(0)
                        setTasks([])
                        setSyncStatus("idle")
                        setSyncError("")
                        setMenuOpen(false)
                        if (!isGuest && user?.email) {
                          localStorage.removeItem(getUserTokenStorageKey(user.email))
                        }
                        if (!isGuest && window.google?.accounts?.id) {
                          window.google.accounts.id.disableAutoSelect()
                        }
                      }}
                      className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-50"
                    >
                      {isGuest ? "Exit guest mode" : "Sign out"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <div className="grid grid-cols-1 gap-4 md:min-h-0 md:flex-1 md:grid-cols-2 md:grid-rows-2">
            {QUADRANTS.map(q => (
              <Quadrant
                key={q.id}
                quadrant={q}
                tasks={sortedTasks.filter(t => t.quadrant === q.id)}
                isDesktop={isDesktop}
                onAddTask={addTask}
                onToggleTask={toggleTask}
                onUpdateTaskTitle={updateTaskTitle}
                onUpdateTaskUrl={updateTaskUrl}
                onAddSubtask={addSubtask}
                onToggleSubtask={toggleSubtask}
                onUpdateSubtaskTitle={updateSubtaskTitle}
                onUpdateSubtaskUrl={updateSubtaskUrl}
                onDeleteSubtask={deleteSubtask}
                onDeleteTask={deleteTask}
              />
            ))}
          </div>
        </DndContext>

        <AppFooter className="mt-8 md:mt-4 md:shrink-0" />
      </div>
    </div>
  )
}

function SignInScreen({
  googleButtonRef,
  googleReady,
  hasClientId,
  guestName,
  onGuestNameChange,
  onContinueAsGuest,
}) {
  return (
    <div className="min-h-[100dvh] bg-[radial-gradient(circle_at_top,_rgba(187,247,208,0.7),_transparent_38%),linear-gradient(180deg,_#f8fafc_0%,_#eef2f7_100%)] px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:p-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-center gap-6 py-8 sm:min-h-[calc(100dvh-3rem)] sm:py-0">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/80 shadow-sm ring-1 ring-white/70 backdrop-blur">
            <div className="grid h-8 w-8 grid-cols-2 gap-1">
              <span className="rounded bg-emerald-300" />
              <span className="rounded bg-amber-200" />
              <span className="rounded bg-rose-200" />
              <span className="rounded bg-sky-200" />
            </div>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900 sm:text-4xl">
            Eisenhower Matrix
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-gray-600 sm:text-base">
            Sign in with Google for cross-device sync, or continue as a guest for local-only access.
          </p>
        </div>

        <div className="grid w-full max-w-3xl gap-4 md:grid-cols-2">
          <div className="rounded-3xl border border-white/80 bg-white/85 p-6 text-center shadow-[0_16px_40px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="mb-5 flex flex-col items-center">
              <div className="mb-2 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-emerald-700">
                Sync
              </div>
            </div>

            <div className="flex min-h-12 items-center justify-center rounded-2xl border border-gray-100 bg-gray-50/70 p-3">
              <div ref={googleButtonRef} />
            </div>
            {!hasClientId && (
              <span className="mt-3 block text-[11px] text-gray-500">Set `VITE_GOOGLE_CLIENT_ID`</span>
            )}
            {hasClientId && !googleReady && (
              <span className="mt-3 block text-[11px] text-gray-500">Loading Google sign-in...</span>
            )}
          </div>

          <div className="rounded-3xl border border-white/80 bg-white/85 p-6 text-center shadow-[0_16px_40px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="mb-5 flex flex-col items-center">
              <div className="mb-2 inline-flex rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-slate-700">
                Guest
              </div>
            </div>

            <div className="space-y-3">
              <input
                value={guestName === DEFAULT_GUEST_NAME ? "" : guestName}
                onChange={e => onGuestNameChange(e.target.value)}
                className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-emerald-300 focus:bg-white focus:ring-2 focus:ring-emerald-100"
                placeholder="Add a nickname"
                maxLength={32}
              />
              <button
                onClick={() => onContinueAsGuest(guestName)}
                className="w-full rounded-2xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Continue without login
              </button>
            </div>
          </div>
        </div>

        <AppFooter />
      </div>
    </div>
  )
}

function AppFooter({ className = "" }) {
  return (
    <footer
      className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-gray-600 ${className}`.trim()}
    >
      <div className="flex items-center gap-3">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="h-6 w-6"
          fill="currentColor"
        >
          <path d="M12 0.3C5.4 0.3 0 5.7 0 12.3c0 5.3 3.4 9.8 8.2 11.4.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.9 1.3 1.9 1.3 1.1 1.9 3 1.3 3.7 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.6-1.3-5.6-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2.9-.3 1.9-.4 2.9-.4 1 0 2 .1 2.9.4 2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.2 0 4.7-2.9 5.7-5.6 6 .4.3.8 1 .8 2.1v3.1c0 .3.2.7.8.6 4.7-1.6 8.1-6.1 8.1-11.4C24 5.7 18.6.3 12 .3z" />
        </svg>
        <a
          href="https://github.com/prateek-mehra"
          className="text-base font-medium hover:text-gray-900"
        >
          prateek-mehra
        </a>
      </div>

      <div className="hidden h-4 w-px bg-gray-300 sm:block" aria-hidden="true" />

      <div className="flex items-center gap-2 text-sm sm:text-base">
        <span>Have feedback? Mail me:</span>
        <a
          href="mailto:partumehra@gmail.com"
          className="inline-flex items-center gap-2 font-medium text-gray-700 hover:text-gray-900"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
            <path fill="#EA4335" d="M3 6.75 12 13l9-6.25V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path fill="#34A853" d="M3 6.75V18l6.75-5.25Z" />
            <path fill="#4285F4" d="M21 6.75V18l-6.75-5.25Z" />
            <path fill="#FBBC04" d="M21 6.75 12 13 3 6.75 4.47 5.6A2 2 0 0 1 5.7 5h12.6a2 2 0 0 1 1.23.6Z" />
          </svg>
          <span>partumehra@gmail.com</span>
        </a>
      </div>
    </footer>
  )
}

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1]
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "="
    )
    return JSON.parse(atob(padded))
  } catch {
    return {}
  }
}

function Quadrant({
  quadrant,
  tasks,
  isDesktop,
  onAddTask,
  onToggleTask,
  onUpdateTaskTitle,
  onUpdateTaskUrl,
  onAddSubtask,
  onToggleSubtask,
  onUpdateSubtaskTitle,
  onUpdateSubtaskUrl,
  onDeleteSubtask,
  onDeleteTask,
}) {
  const [input, setInput] = useState("")
  const [addingTask, setAddingTask] = useState(false)

  const { setNodeRef } = useDroppable({
    id: quadrant.id,
    data: { quadrant: quadrant.id },
  })

  const handleAdd = () => {
    if (!input.trim()) return
    onAddTask(input, quadrant.id)
    setInput("")
    setAddingTask(false)
  }

  const toneClasses = {
    dominant: "bg-white/82 shadow-[0_14px_34px_rgba(225,29,72,0.06)]",
    balanced: "bg-white/78 shadow-[0_14px_34px_rgba(15,23,42,0.05)]",
    muted:
      "bg-slate-100/78 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] opacity-85",
  }

  const headingClasses =
    quadrant.tone === "dominant" ? "text-rose-700" : "text-gray-900"
  const subtitleClasses =
    quadrant.tone === "dominant" ? "text-rose-500" : "text-gray-500"
  const countClasses =
    quadrant.tone === "dominant"
      ? "text-rose-400"
      : "text-gray-400"

  return (
    <div
      className={`flex flex-col rounded-[28px] p-4 md:min-h-[18rem] ${
        toneClasses[quadrant.tone]
      } md:min-h-0`}
    >
      <div className="mb-4 border-b border-white/70 pb-3">
        <div className="flex items-center justify-between gap-3">
          <h2
            className={`font-semibold ${
              quadrant.tone === "dominant"
                ? "text-base sm:text-lg"
                : "text-sm sm:text-base"
            } ${headingClasses}`}
          >
            {quadrant.title}
          </h2>
          <span className={`text-[11px] uppercase tracking-[0.18em] ${countClasses}`}>
            {tasks.length}
          </span>
        </div>
        <p className={`mt-1 text-xs sm:text-sm ${subtitleClasses}`}>{quadrant.subtitle}</p>
      </div>

      <SortableContext
        items={tasks.map(t => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className="flex-1 space-y-2 overflow-auto overscroll-contain pr-1 md:min-h-0"
        >
          {tasks.map(task => (
            <SortableTask
              key={task.id}
              task={task}
              isDesktop={isDesktop}
              onToggle={onToggleTask}
              onUpdateTaskTitle={onUpdateTaskTitle}
              onUpdateTaskUrl={onUpdateTaskUrl}
              onAddSubtask={onAddSubtask}
              onToggleSubtask={onToggleSubtask}
              onUpdateSubtaskTitle={onUpdateSubtaskTitle}
              onUpdateSubtaskUrl={onUpdateSubtaskUrl}
              onDeleteSubtask={onDeleteSubtask}
              onDelete={onDeleteTask}
            />
          ))}
        </div>
      </SortableContext>

      <div className="mt-3">
        {addingTask ? (
          <input
            className="w-full rounded-2xl bg-white/85 px-3 py-3 text-sm text-gray-800 outline-none ring-1 ring-black/5 transition focus:bg-white focus:ring-2 focus:ring-emerald-100"
            placeholder="+ add task..."
            value={input}
            autoFocus
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleAdd()
              if (e.key === "Escape") {
                setInput("")
                setAddingTask(false)
              }
            }}
            onBlur={() => {
              if (!input.trim()) {
                setAddingTask(false)
              }
            }}
          />
        ) : (
          <button
            onClick={() => setAddingTask(true)}
            className="w-full rounded-2xl px-1 py-3 text-left text-sm text-gray-400 transition hover:text-gray-600"
            aria-label={`Add task to ${quadrant.title}`}
          >
            + add task...
          </button>
        )}
      </div>
    </div>
  )
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const normalizeUrl = (value) => {
  const next = (value || "").trim()
  if (!next) return ""
  if (/^https?:\/\//i.test(next)) return next
  return `https://${next}`
}

const openExternalLink = (url) => {
  const normalized = normalizeUrl(url)
  if (!normalized) return
  window.open(normalized, "_blank", "noopener,noreferrer")
}

function DragGrip({ attributes, listeners }) {
  const stopRowGesture = (event) => {
    event.stopPropagation()
  }

  const startPointerDrag = (event) => {
    listeners?.onPointerDown?.(event)
    event.stopPropagation()
  }

  const startTouchDrag = (event) => {
    listeners?.onTouchStart?.(event)
    event.stopPropagation()
  }

  return (
    <button
      type="button"
      {...attributes}
      {...listeners}
      onClick={e => e.stopPropagation()}
      onPointerDown={startPointerDrag}
      onPointerMove={stopRowGesture}
      onPointerUp={stopRowGesture}
      onPointerCancel={stopRowGesture}
      onTouchStart={startTouchDrag}
      onTouchMove={stopRowGesture}
      onTouchEnd={stopRowGesture}
      onTouchCancel={stopRowGesture}
      style={{ touchAction: "none" }}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-gray-300 transition hover:bg-white/70 hover:text-gray-500"
      title="Drag task"
      aria-label="Drag task"
    >
      <span className="grid grid-cols-2 gap-0.5">
        {Array.from({ length: 6 }).map((_, index) => (
          <span key={index} className="h-1 w-1 rounded-full bg-current" />
        ))}
      </span>
    </button>
  )
}

function ActionButton({
  color,
  icon,
  label,
  onClick,
  disabled = false,
  active = false,
  className = "",
}) {
  const toneClasses =
    color === "green"
      ? active
        ? "bg-emerald-500 text-white hover:bg-emerald-500"
        : "bg-white text-emerald-600 ring-1 ring-emerald-200 hover:bg-emerald-50"
      : "bg-rose-50 text-rose-600 hover:bg-rose-100"

  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={e => e.stopPropagation()}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition ${toneClasses} ${
        disabled ? "cursor-not-allowed opacity-35" : ""
      } ${className}`.trim()}
    >
      {icon === "check" ? (
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
          <path
            d="M3.5 8.2 6.6 11.2 12.5 4.8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
          <path d="M4 4 12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 4 4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  )
}

function LaunchLinkButton({ url, label }) {
  if (!url) return null

  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        openExternalLink(url)
      }}
      onPointerDown={e => e.stopPropagation()}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-gray-400 transition hover:bg-white/70 hover:text-gray-700"
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 stroke-current" fill="none">
        <path d="M14 5h5v5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 14 19 5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function EditMenu({ open, onToggle, onRename, onEditLink, hasLink, label }) {
  const buttonRef = useRef(null)
  const [menuPosition, setMenuPosition] = useState(null)

  const getMenuPosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return null

    const menuWidth = 128
    const menuHeight = 96
    const margin = 8
    const topGap = 4
    const hasRoomBelow = rect.bottom + topGap + menuHeight <= window.innerHeight - margin
    const top = hasRoomBelow
      ? rect.bottom + topGap
      : Math.max(margin, rect.top - menuHeight - topGap)
    const left = Math.min(
      window.innerWidth - menuWidth - margin,
      Math.max(margin, rect.right - menuWidth)
    )

    return { left, top }
  }, [])

  useEffect(() => {
    if (!open) return undefined

    const updateMenuPosition = () => {
      const nextPosition = getMenuPosition()
      if (nextPosition) setMenuPosition(nextPosition)
    }

    const animationFrame = requestAnimationFrame(updateMenuPosition)
    window.addEventListener("resize", updateMenuPosition)
    window.addEventListener("scroll", updateMenuPosition, true)

    return () => {
      cancelAnimationFrame(animationFrame)
      window.removeEventListener("resize", updateMenuPosition)
      window.removeEventListener("scroll", updateMenuPosition, true)
    }
  }, [getMenuPosition, open])

  const menu =
    open && menuPosition && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed z-[100] min-w-32 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-[0_18px_40px_rgba(15,23,42,0.16)]"
            style={{ left: menuPosition.left, top: menuPosition.top }}
            onClick={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                onRename()
              }}
              className="w-full rounded-xl px-3 py-2 text-left text-xs text-gray-700 transition hover:bg-gray-50 sm:text-sm"
            >
              Rename
            </button>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                onEditLink()
              }}
              className="w-full rounded-xl px-3 py-2 text-left text-xs text-gray-700 transition hover:bg-gray-50 sm:text-sm"
            >
              {hasLink ? "Edit link" : "Add link"}
            </button>
          </div>,
          document.body
        )
      : null

  return (
    <div className="relative z-20 shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={e => {
          e.stopPropagation()
          setMenuPosition(open ? null : getMenuPosition())
          onToggle()
        }}
        onPointerDown={e => e.stopPropagation()}
        className={`flex h-9 items-center gap-1.5 rounded-full border border-slate-300 bg-white px-2.5 text-gray-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 ${
          open ? "border-gray-300 text-gray-700" : ""
        }`}
        title={label}
        aria-label={label}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 stroke-current" fill="none">
          <path d="M4 20h4l9.8-9.8a1.5 1.5 0 0 0 0-2.1l-1.9-1.9a1.5 1.5 0 0 0-2.1 0L4 16v4Z" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m12.5 7.5 4 4" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menu}
    </div>
  )
}

function SortableTask({
  task,
  isDesktop,
  onToggle,
  onUpdateTaskTitle,
  onUpdateTaskUrl,
  onAddSubtask,
  onToggleSubtask,
  onUpdateSubtaskTitle,
  onUpdateSubtaskUrl,
  onDeleteSubtask,
  onDelete,
}) {
  const [subtaskInput, setSubtaskInput] = useState("")
  const [subtasksExpanded, setSubtasksExpanded] = useState(false)
  const [addingSubtask, setAddingSubtask] = useState(false)
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)
  const [editingTaskTitle, setEditingTaskTitle] = useState(false)
  const [editingTaskLink, setEditingTaskLink] = useState(false)
  const [taskTitleInput, setTaskTitleInput] = useState(task.title)
  const [taskUrlInput, setTaskUrlInput] = useState(task.url || "")
  const [editingSubtaskTitleId, setEditingSubtaskTitleId] = useState(null)
  const [editingSubtaskLinkId, setEditingSubtaskLinkId] = useState(null)
  const [subtaskMenuId, setSubtaskMenuId] = useState(null)
  const [subtaskTitleInput, setSubtaskTitleInput] = useState("")
  const [subtaskUrlInput, setSubtaskUrlInput] = useState("")
  const [rowSwipeOffset, setRowSwipeOffset] = useState(0)
  const [subtaskSwipeOffsets, setSubtaskSwipeOffsets] = useState({})
  const rowSwipeStateRef = useRef(null)
  const shouldSuppressClickRef = useRef(false)
  const subtaskSwipeStateRef = useRef({})
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: task.id,
    data: { quadrant: task.quadrant },
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const desktopDragProps = isDesktop ? { ...attributes, ...listeners } : {}

  const subtasks = normalizeSubtasks(task.subtasks)
  const completedSubtasks = subtasks.filter(subtask => subtask.completed).length
  const hasIncompleteSubtasks = subtasks.some(subtask => !subtask.completed)
  const taskLocked = hasIncompleteSubtasks
  const taskDeletable = !hasIncompleteSubtasks
  const hasSubtasks = subtasks.length > 0
  const subtaskCompletionPercent = hasSubtasks
    ? Math.round((completedSubtasks / subtasks.length) * 100)
    : 0

  const toggleSubtasksExpanded = () => {
    setSubtasksExpanded(expanded => !expanded)
  }

  const handleAddSubtask = () => {
    if (!subtaskInput.trim()) return
    onAddSubtask(task.id, subtaskInput)
    setSubtaskInput("")
    setSubtasksExpanded(true)
    setAddingSubtask(false)
  }

  const saveTaskTitle = () => {
    const nextTitle = taskTitleInput.trim()
    setEditingTaskTitle(false)
    if (!nextTitle) {
      setTaskTitleInput(task.title)
      return
    }
    onUpdateTaskTitle(task.id, nextTitle)
  }

  const saveTaskUrl = () => {
    onUpdateTaskUrl(task.id, normalizeUrl(taskUrlInput))
    setEditingTaskLink(false)
  }

  const saveSubtaskTitle = (subtaskId) => {
    const nextTitle = subtaskTitleInput.trim()
    setEditingSubtaskTitleId(null)
    if (!nextTitle) {
      setSubtaskTitleInput("")
      return
    }
    onUpdateSubtaskTitle(task.id, subtaskId, nextTitle)
    setSubtaskTitleInput("")
  }

  const saveSubtaskUrl = (subtaskId) => {
    onUpdateSubtaskUrl(task.id, subtaskId, normalizeUrl(subtaskUrlInput))
    setEditingSubtaskLinkId(null)
    setSubtaskUrlInput("")
  }

  const handleRowPointerDown = (event) => {
    if (isDesktop) return
    if (
      editingTaskTitle ||
      editingTaskLink ||
      addingSubtask ||
      editingSubtaskTitleId ||
      editingSubtaskLinkId
    ) {
      return
    }

    rowSwipeStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      offset: 0,
    }
    shouldSuppressClickRef.current = false
  }

  const handleRowPointerMove = (event) => {
    if (isDesktop) return
    const state = rowSwipeStateRef.current
    if (!state) return

    const deltaX = event.clientX - state.startX
    const deltaY = event.clientY - state.startY

    if (Math.abs(deltaY) > 18 && Math.abs(deltaY) > Math.abs(deltaX)) {
      state.offset = 0
      setRowSwipeOffset(0)
      return
    }

    if (deltaX > 0) {
      state.offset = clamp(deltaX, 0, 92)
      setRowSwipeOffset(state.offset)
      if (deltaX > 8) shouldSuppressClickRef.current = true
      return
    }

    if (deltaX < 0) {
      state.offset = clamp(deltaX, -92, 0)
      setRowSwipeOffset(state.offset)
      if (Math.abs(deltaX) > 8) shouldSuppressClickRef.current = true
    }
  }

  const handleRowPointerEnd = () => {
    if (isDesktop) return
    const offset = rowSwipeStateRef.current?.offset || 0
    rowSwipeStateRef.current = null

    if (offset >= 72) {
      onToggle(task.id)
    } else if (offset <= -72 && taskDeletable) {
      onDelete(task.id)
    }
    setRowSwipeOffset(0)
  }

  const startSubtaskSwipe = (subtaskId, event) => {
    subtaskSwipeStateRef.current[subtaskId] = {
      startX: event.clientX,
      startY: event.clientY,
      offset: 0,
    }
    setSubtaskSwipeOffsets(current => ({ ...current, [subtaskId]: 0 }))
  }

  const moveSubtaskSwipe = (subtaskId, event) => {
    const state = subtaskSwipeStateRef.current[subtaskId]
    if (!state) return 0

    const deltaX = event.clientX - state.startX
    const deltaY = event.clientY - state.startY
    if (Math.abs(deltaY) > 16 && Math.abs(deltaY) > Math.abs(deltaX)) {
      state.offset = 0
      setSubtaskSwipeOffsets(current => ({ ...current, [subtaskId]: 0 }))
      return 0
    }

    state.offset = clamp(deltaX, -84, 84)
    setSubtaskSwipeOffsets(current => ({ ...current, [subtaskId]: state.offset }))
    return state.offset
  }

  const endSubtaskSwipe = (subtask) => {
    const state = subtaskSwipeStateRef.current[subtask.id]
    const shouldToggle = state?.offset >= 64
    const shouldDelete = state?.offset <= -64
    delete subtaskSwipeStateRef.current[subtask.id]
    setSubtaskSwipeOffsets(current => ({ ...current, [subtask.id]: 0 }))
    if (shouldToggle) {
      onToggleSubtask(task.id, subtask.id)
    } else if (shouldDelete) {
      onDeleteSubtask(task.id, subtask.id)
    }
    return 0
  }

  return (
    <div ref={setNodeRef} style={style} className="relative text-sm sm:text-base">
      <div
        className="relative overflow-hidden rounded-2xl bg-white/75"
        onClick={() => {
          if (shouldSuppressClickRef.current) {
            shouldSuppressClickRef.current = false
            return
          }
          setTaskMenuOpen(false)
          setSubtaskMenuId(null)
          toggleSubtasksExpanded()
        }}
      >
        <div
          className={`pointer-events-none absolute inset-y-0 left-0 flex items-center px-4 text-[11px] font-medium uppercase tracking-[0.14em] text-emerald-600 transition ${
            rowSwipeOffset > 16 ? "opacity-100" : "opacity-0"
          } md:hidden`}
        >
          Done
        </div>
        <div
          className={`pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-[11px] font-medium uppercase tracking-[0.14em] transition ${
            rowSwipeOffset < -16 ? "opacity-100" : "opacity-0"
          } ${taskDeletable ? "text-rose-600" : "text-gray-400"} md:hidden`}
        >
          {taskDeletable ? "Delete" : "Finish subtasks"}
        </div>

        <div
          className="px-3 py-3 transition"
          style={{
            transform: `translateX(${isDesktop ? 0 : rowSwipeOffset}px)`,
            touchAction: isDesktop ? "auto" : "pan-y",
          }}
          onPointerDown={handleRowPointerDown}
          onPointerMove={handleRowPointerMove}
          onPointerUp={handleRowPointerEnd}
          onPointerCancel={handleRowPointerEnd}
        >
          <div className="flex items-center gap-2.5">
            <ActionButton
              color="green"
              icon="check"
              label={taskLocked ? "Complete all subtasks first" : `Complete ${task.title}`}
              onClick={e => {
                e.stopPropagation()
                if (!taskLocked) onToggle(task.id)
              }}
              disabled={taskLocked}
              active={task.completed}
              className="hidden md:grid"
            />
            <div className="md:hidden">
              <DragGrip attributes={attributes} listeners={listeners} />
            </div>

            <div className="min-w-0 flex-1">
              {editingTaskTitle ? (
                <input
                  className="w-full rounded-xl bg-white px-3 py-2 text-sm text-gray-800 outline-none ring-1 ring-black/5 focus:ring-2 focus:ring-rose-100 sm:text-base"
                  value={taskTitleInput}
                  autoFocus
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => e.stopPropagation()}
                  onChange={e => setTaskTitleInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") saveTaskTitle()
                    if (e.key === "Escape") {
                      setTaskTitleInput(task.title)
                      setEditingTaskTitle(false)
                    }
                  }}
                  onBlur={saveTaskTitle}
                  aria-label={`Rename ${task.title}`}
                />
              ) : (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    if (shouldSuppressClickRef.current) {
                      shouldSuppressClickRef.current = false
                      return
                    }
                    toggleSubtasksExpanded()
                  }}
                  className="flex min-w-0 w-full items-center gap-1.5 rounded-xl text-left"
                  aria-expanded={subtasksExpanded}
                  {...desktopDragProps}
                >
                  <span className={`min-w-0 truncate text-gray-800 ${task.completed ? "line-through text-gray-400" : ""}`}>
                    {task.title}
                  </span>
                  <LaunchLinkButton url={task.url} label={`Open link for ${task.title}`} />
                </button>
              )}
            </div>

            {subtasks.length > 0 && (
              <span
                className="relative isolate h-5 min-w-11 shrink-0 overflow-hidden rounded-full bg-gray-200/70 px-2 text-center text-[11px] leading-5 text-gray-600"
                aria-label={`${completedSubtasks} of ${subtasks.length} subtasks complete`}
                title={`${subtaskCompletionPercent}% complete`}
              >
                <span
                  className="absolute inset-y-0 left-0 -z-10 bg-emerald-400 transition-[width] duration-200"
                  style={{ width: `${subtaskCompletionPercent}%` }}
                />
                <span className="relative font-medium">
                  {completedSubtasks}/{subtasks.length}
                </span>
              </span>
            )}

            <EditMenu
              open={taskMenuOpen}
              onToggle={() => setTaskMenuOpen(open => !open)}
              onRename={() => {
                setTaskMenuOpen(false)
                setTaskTitleInput(task.title)
                setEditingTaskTitle(true)
              }}
              onEditLink={() => {
                setTaskMenuOpen(false)
                setTaskUrlInput(task.url || "")
                setEditingTaskLink(true)
              }}
              hasLink={Boolean(task.url)}
              label={`Edit ${task.title}`}
            />
            <ActionButton
              color="red"
              icon="close"
              label={taskLocked ? "Complete all subtasks first" : `Delete ${task.title}`}
              onClick={e => {
                e.stopPropagation()
                if (!taskLocked) onDelete(task.id)
              }}
              disabled={taskLocked}
              className="hidden md:grid"
            />
          </div>

          {editingTaskLink && (
            <div className="mt-3 flex gap-2 pl-9">
              <input
                className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2 text-xs text-gray-700 outline-none ring-1 ring-black/5 focus:ring-2 focus:ring-rose-100 sm:text-sm"
                placeholder="https://example.com"
                value={taskUrlInput}
                autoFocus
                onPointerDown={e => e.stopPropagation()}
                onChange={e => setTaskUrlInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") saveTaskUrl()
                  if (e.key === "Escape") {
                    setTaskUrlInput(task.url || "")
                    setEditingTaskLink(false)
                  }
                }}
              />
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation()
                  saveTaskUrl()
                }}
                className="rounded-xl bg-white px-3 py-2 text-xs text-gray-600 shadow-sm transition hover:bg-gray-50 sm:text-sm"
              >
                Save
              </button>
              {task.url && (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    onUpdateTaskUrl(task.id, "")
                    setTaskUrlInput("")
                    setEditingTaskLink(false)
                  }}
                  className="rounded-xl bg-white px-3 py-2 text-xs text-gray-500 shadow-sm transition hover:bg-gray-50 sm:text-sm"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          <div
            className={`mt-2 space-y-2 ${
              !subtasksExpanded && !addingSubtask ? "hidden" : ""
            }`}
          >
            {subtasks.map(subtask => (
              <div key={subtask.id} className="pl-9">
                <div
                  className={`relative rounded-xl ${
                    subtaskMenuId === subtask.id ? "overflow-visible" : "overflow-hidden"
                  }`}
                >
                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 flex items-center px-3 text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-600 opacity-0 transition md:hidden"
                    style={{ opacity: (subtaskSwipeOffsets[subtask.id] || 0) > 14 ? 1 : 0 }}
                  >
                    Done
                  </div>
                  <div
                    className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-[10px] font-medium uppercase tracking-[0.16em] text-rose-600 opacity-0 transition md:hidden"
                    style={{ opacity: (subtaskSwipeOffsets[subtask.id] || 0) < -14 ? 1 : 0 }}
                  >
                    Delete
                  </div>

                  <div
                    className="flex items-center gap-2 rounded-xl py-1.5 text-xs sm:text-sm"
                    style={{
                      transform: `translateX(${isDesktop ? 0 : subtaskSwipeOffsets[subtask.id] || 0}px)`,
                      touchAction: isDesktop ? "auto" : "pan-y",
                    }}
                    onPointerDown={e => {
                      if (!isDesktop) startSubtaskSwipe(subtask.id, e)
                    }}
                    onPointerMove={e => {
                      if (!isDesktop) moveSubtaskSwipe(subtask.id, e)
                    }}
                    onPointerUp={() => {
                      if (!isDesktop) endSubtaskSwipe(subtask)
                    }}
                    onPointerCancel={() => {
                      if (!isDesktop) endSubtaskSwipe(subtask)
                    }}
                  >
                    <ActionButton
                      color="green"
                      icon="check"
                      label={`Complete ${subtask.title}`}
                      onClick={e => {
                        e.stopPropagation()
                        onToggleSubtask(task.id, subtask.id)
                      }}
                      active={subtask.completed}
                      className="hidden md:grid"
                    />
                    {editingSubtaskTitleId === subtask.id ? (
                      <input
                        className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2 text-xs text-gray-700 outline-none ring-1 ring-black/5 focus:ring-2 focus:ring-rose-100 sm:text-sm"
                        value={subtaskTitleInput}
                        autoFocus
                        onPointerDown={e => e.stopPropagation()}
                        onChange={e => setSubtaskTitleInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") saveSubtaskTitle(subtask.id)
                          if (e.key === "Escape") {
                            setEditingSubtaskTitleId(null)
                            setSubtaskTitleInput("")
                          }
                        }}
                        onBlur={() => saveSubtaskTitle(subtask.id)}
                        aria-label={`Rename subtask ${subtask.title}`}
                      />
                    ) : (
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`min-w-0 truncate ${subtask.completed ? "line-through text-gray-300" : "text-gray-400"}`}>
                            {subtask.title}
                          </span>
                          <LaunchLinkButton
                            url={subtask.url}
                            label={`Open link for ${subtask.title}`}
                          />
                        </div>
                      </div>
                    )}

                    <EditMenu
                      open={subtaskMenuId === subtask.id}
                      onToggle={() =>
                        setSubtaskMenuId(current => (current === subtask.id ? null : subtask.id))
                      }
                      onRename={() => {
                        setSubtaskMenuId(null)
                        setEditingSubtaskLinkId(null)
                        setSubtaskTitleInput(subtask.title)
                        setEditingSubtaskTitleId(subtask.id)
                      }}
                      onEditLink={() => {
                        setSubtaskMenuId(null)
                        setEditingSubtaskTitleId(null)
                        setSubtaskUrlInput(subtask.url || "")
                        setEditingSubtaskLinkId(subtask.id)
                      }}
                      hasLink={Boolean(subtask.url)}
                      label={`Edit ${subtask.title}`}
                    />
                    <ActionButton
                      color="red"
                      icon="close"
                      label={`Delete ${subtask.title}`}
                      onClick={e => {
                        e.stopPropagation()
                        onDeleteSubtask(task.id, subtask.id)
                      }}
                      className="hidden md:grid"
                    />
                  </div>
                </div>

                {editingSubtaskLinkId === subtask.id && (
                  <div className="mt-1 flex gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2 text-xs text-gray-700 outline-none ring-1 ring-black/5 focus:ring-2 focus:ring-rose-100 sm:text-sm"
                      placeholder="https://example.com"
                      value={subtaskUrlInput}
                      autoFocus
                      onPointerDown={e => e.stopPropagation()}
                      onChange={e => setSubtaskUrlInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") saveSubtaskUrl(subtask.id)
                        if (e.key === "Escape") {
                          setEditingSubtaskLinkId(null)
                          setSubtaskUrlInput("")
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => saveSubtaskUrl(subtask.id)}
                      className="rounded-xl bg-white px-3 py-2 text-xs text-gray-600 shadow-sm transition hover:bg-gray-50 sm:text-sm"
                    >
                      Save
                    </button>
                    {subtask.url && (
                      <button
                        type="button"
                        onClick={() => {
                          onUpdateSubtaskUrl(task.id, subtask.id, "")
                          setEditingSubtaskLinkId(null)
                          setSubtaskUrlInput("")
                        }}
                        className="rounded-xl bg-white px-3 py-2 text-xs text-gray-500 shadow-sm transition hover:bg-gray-50 sm:text-sm"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

            {addingSubtask ? (
              <div className="flex gap-2 pl-9">
                <input
                  className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2 text-xs text-gray-700 outline-none ring-1 ring-black/5 focus:ring-2 focus:ring-rose-100 sm:text-sm"
                  placeholder="Add subtask"
                  value={subtaskInput}
                  autoFocus
                  onPointerDown={e => e.stopPropagation()}
                  onChange={e => setSubtaskInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") handleAddSubtask()
                  if (e.key === "Escape") {
                    setSubtaskInput("")
                    setAddingSubtask(false)
                    if (!hasSubtasks) setSubtasksExpanded(false)
                  }
                }}
              />
                <button
                  type="button"
                  onClick={handleAddSubtask}
                  className="rounded-xl bg-white px-3 py-2 text-xs text-gray-600 shadow-sm transition hover:bg-gray-50 sm:text-sm"
                >
                  Add
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation()
                  setSubtasksExpanded(true)
                  setAddingSubtask(true)
                }}
                className="w-full pl-9 text-left text-xs text-gray-400 transition hover:text-gray-600 sm:text-sm"
              >
                + add subtask...
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
