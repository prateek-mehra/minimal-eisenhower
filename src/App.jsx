import { useState, useEffect, useRef } from "react"
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

const STORAGE_KEY = "eisenhower_tasks_v1"
const USER_KEY = "eisenhower_google_user_v1"
const TASKLIST_KEY = "eisenhower_google_tasklist_id_v1"

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks"
const TASKLIST_TITLE = "Eisenhower Matrix"
const TASKS_API_BASE = "https://tasks.googleapis.com/tasks/v1"

const QUADRANTS = [
  { id: "UI", title: "Urgent & Important", subtitle: "Do first" },
  { id: "NI", title: "Not Urgent & Important", subtitle: "Schedule" },
  { id: "UN", title: "Urgent & Not Important", subtitle: "Delegate" },
  { id: "NN", title: "Not Urgent & Not Important", subtitle: "Eliminate" },
]

const generateId = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `task_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export default function App() {
  const [tasks, setTasks] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem(USER_KEY)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })
  const googleButtonRef = useRef(null)
  const tokenClientRef = useRef(null)
  const tokenRequestRef = useRef(null)
  const [googleReady, setGoogleReady] = useState(false)
  const [accessToken, setAccessToken] = useState(null)
  const [tokenExpiry, setTokenExpiry] = useState(0)
  const [tasklistId, setTasklistId] = useState(() => {
    try {
      const stored = localStorage.getItem(TASKLIST_KEY)
      return stored || null
    } catch {
      return null
    }
  })
  const [tasksError, setTasksError] = useState("")

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
  }, [tasks])

  useEffect(() => {
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user))
    } else {
      localStorage.removeItem(USER_KEY)
    }
  }, [user])

  useEffect(() => {
    if (tasklistId) {
      localStorage.setItem(TASKLIST_KEY, tasklistId)
    } else {
      localStorage.removeItem(TASKLIST_KEY)
    }
  }, [tasklistId])

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
          scope: TASKS_SCOPE,
          callback: (response) => {
            if (response?.error) {
              setTasksError("Google Tasks access denied.")
              if (tokenRequestRef.current) {
                tokenRequestRef.current.reject(response.error)
                tokenRequestRef.current = null
              }
              return
            }
            if (response?.access_token) {
              const expiresInMs = (response.expires_in || 0) * 1000
              setAccessToken(response.access_token)
              setTokenExpiry(Date.now() + expiresInMs)
              setTasksError("")
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
  }, [])

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return
    if (!googleReady) return
    renderGoogleButton()
  }, [googleReady, user])

  const renderGoogleButton = () => {
    if (!window.google?.accounts?.id) return
    if (!googleButtonRef.current) return
    googleButtonRef.current.innerHTML = ""
    window.google.accounts.id.renderButton(googleButtonRef.current, {
      theme: "outline",
      size: "large",
      text: "continue_with",
      width: 260,
    })
  }

  const requestAccessToken = ({ prompt }) => {
    if (!tokenClientRef.current) return Promise.resolve(null)
    if (tokenRequestRef.current) {
      return tokenRequestRef.current.promise
    }

    let resolve = () => {}
    let reject = () => {}
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    tokenRequestRef.current = { resolve, reject, promise }

    tokenClientRef.current.requestAccessToken({ prompt })
    return promise
  }

  const ensureAccessToken = async ({ interactive } = {}) => {
    const isValid =
      accessToken && tokenExpiry && Date.now() < tokenExpiry - 60_000
    if (isValid) return accessToken
    if (!tokenClientRef.current) return null

    try {
      return await requestAccessToken({ prompt: interactive ? "consent" : "" })
    } catch {
      if (interactive) return null
      try {
        return await requestAccessToken({ prompt: "consent" })
      } catch {
        return null
      }
    }
  }

  const tasksFetch = async (path, { method = "GET", body, token } = {}) => {
    const response = await fetch(`${TASKS_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (response.status === 204) return null
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || `Tasks API error: ${response.status}`)
    }
    return response.json()
  }

  const ensureTasklistId = async (token) => {
    if (tasklistId) return tasklistId
    const data = await tasksFetch("/users/@me/lists", { token })
    const existing = data?.items?.find(list => list.title === TASKLIST_TITLE)
    if (existing?.id) {
      setTasklistId(existing.id)
      return existing.id
    }
    const created = await tasksFetch("/users/@me/lists", {
      method: "POST",
      token,
      body: { title: TASKLIST_TITLE },
    })
    if (created?.id) {
      setTasklistId(created.id)
      return created.id
    }
    return null
  }

  const getTasksAccess = async ({ interactive } = {}) => {
    const token = await ensureAccessToken({ interactive })
    if (!token) return null
    try {
      const listId = await ensureTasklistId(token)
      if (!listId) return null
      return { token, listId }
    } catch {
      return null
    }
  }

  const buildTaskPayload = (task) => ({
    title: task.title,
    status: task.completed ? "completed" : "needsAction",
    notes: `Quadrant: ${task.quadrant}`,
  })

  const syncCreateTask = async (task) => {
    const access = await getTasksAccess({ interactive: true })
    if (!access) return

    try {
      const created = await tasksFetch(
        `/lists/${access.listId}/tasks`,
        {
          method: "POST",
          token: access.token,
          body: buildTaskPayload(task),
        }
      )
      if (created?.id) {
        setTasks(prev =>
          prev.map(t =>
            t.id === task.id ? { ...t, googleTaskId: created.id } : t
          )
        )
        setTasksError("")
      }
    } catch {
      setTasksError("Google Tasks sync failed.")
    }
  }

  const syncUpdateTask = async (task) => {
    if (!task) return
    if (!task.googleTaskId) {
      await syncCreateTask(task)
      return
    }
    const access = await getTasksAccess({ interactive: false })
    if (!access) return

    try {
      await tasksFetch(
        `/lists/${access.listId}/tasks/${task.googleTaskId}`,
        {
          method: "PUT",
          token: access.token,
          body: buildTaskPayload(task),
        }
      )
      setTasksError("")
    } catch {
      setTasksError("Google Tasks sync failed.")
    }
  }

  const syncDeleteTask = async (task) => {
    if (!task?.googleTaskId) return
    const access = await getTasksAccess({ interactive: false })
    if (!access) return
    try {
      await tasksFetch(
        `/lists/${access.listId}/tasks/${task.googleTaskId}`,
        { method: "DELETE", token: access.token }
      )
      setTasksError("")
    } catch {
      setTasksError("Google Tasks sync failed.")
    }
  }

  const syncClearCompleted = async (completedTasks) => {
    if (!completedTasks.length) return
    const access = await getTasksAccess({ interactive: false })
    if (!access) return
    try {
      await Promise.all(
        completedTasks.map(task =>
          task.googleTaskId
            ? tasksFetch(
                `/lists/${access.listId}/tasks/${task.googleTaskId}`,
                { method: "DELETE", token: access.token }
              )
            : Promise.resolve()
        )
      )
      setTasksError("")
    } catch {
      setTasksError("Google Tasks sync failed.")
    }
  }

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

    let createdTask = null
    setTasks(prev => {
      const newTask = {
        id: generateId(),
        title,
        quadrant,
        completed: false,
        order: prev.filter(t => t.quadrant === quadrant).length,
      }
      createdTask = newTask
      return [...prev, newTask]
    })
    if (createdTask) {
      syncCreateTask(createdTask)
    }
  }

  const toggleTask = (id) => {
    let updatedTask = null
    setTasks(prev =>
      prev.map(t => {
        if (t.id !== id) return t
        updatedTask = { ...t, completed: !t.completed }
        return updatedTask
      })
    )
    if (updatedTask) {
      syncUpdateTask(updatedTask)
    }
  }

  const deleteTask = (id) => {
    const target = tasks.find(t => t.id === id)
    setTasks(prev => prev.filter(t => t.id !== id))
    if (target) {
      syncDeleteTask(target)
    }
  }

  const clearCompleted = () => {
    const completed = tasks.filter(t => t.completed)
    setTasks(prev => prev.filter(t => !t.completed))
    syncClearCompleted(completed)
  }

  const reorderTasks = (quadrantTasks, from, to) => {
    const reordered = arrayMove(quadrantTasks, from, to)

    const updated = reordered.map((task, index) => ({
      ...task,
      order: index,
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
    const targetQuadrant =
      over.data?.current?.quadrant ?? sourceQuadrant

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

    let movedTask = null
    setTasks(prev => {
      const sourceTasks = prev
        .filter(t => t.quadrant === sourceQuadrant && t.id !== active.id)
        .sort((a, b) => a.order - b.order)
        .map((t, i) => ({ ...t, order: i }))

      const targetTasks = prev
        .filter(t => t.quadrant === targetQuadrant)
        .sort((a, b) => a.order - b.order)

      movedTask = {
        ...activeTask,
        quadrant: targetQuadrant,
        order: targetTasks.length,
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
    if (movedTask) {
      syncUpdateTask(movedTask)
    }
  }

  if (!user) {
    return (
      <SignInScreen
        googleButtonRef={googleButtonRef}
        googleReady={googleReady}
        hasClientId={!!GOOGLE_CLIENT_ID}
      />
    )
  }

  return (
    <div className="min-h-[100dvh] bg-gray-50 px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:p-6">
      <div className="mx-auto w-full max-w-5xl">
        <div className="sticky top-0 z-10 -mx-4 mb-4 bg-gray-50/95 px-4 pb-3 pt-4 backdrop-blur sm:static sm:mx-0 sm:mb-6 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold sm:text-2xl">
              Eisenhower Matrix
            </h1>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-2 py-1 text-xs sm:text-sm">
                <img
                  src={user.picture}
                  alt={`${user.name} avatar`}
                  className="h-6 w-6 rounded-full"
                  referrerPolicy="no-referrer"
                />
                <span className="hidden sm:inline">{user.name}</span>
                <button
                  onClick={() => {
                    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
                      window.google.accounts.oauth2.revoke(accessToken, () => {})
                    }
                    setUser(null)
                    setAccessToken(null)
                    setTokenExpiry(0)
                    setTasklistId(null)
                    if (window.google?.accounts?.id) {
                      window.google.accounts.id.disableAutoSelect()
                    }
                  }}
                  className="rounded-full px-2 py-1 text-xs text-gray-600 hover:text-gray-900"
                >
                  Sign out
                </button>
              </div>

              {!accessToken ? (
                <button
                  onClick={() => {
                    getTasksAccess({ interactive: true })
                  }}
                  className="text-xs sm:text-sm px-3 py-2 rounded-md border border-gray-300 hover:bg-gray-100"
                >
                  Connect Google Tasks
                </button>
              ) : (
                <span className="text-[11px] text-gray-500 sm:text-xs">
                  Google Tasks connected
                </span>
              )}

              <button
                onClick={clearCompleted}
                className="text-xs sm:text-sm px-3 py-2 rounded-md border border-gray-300 hover:bg-gray-100"
              >
                Clear completed
              </button>
            </div>
          </div>
          {tasksError && (
            <p className="mt-1 text-xs text-red-500">{tasksError}</p>
          )}
          <p className="mt-1 text-xs text-gray-500 sm:text-sm">
            Tap and hold to drag, or scroll each quadrant to view more tasks.
          </p>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:grid-rows-2 md:h-[80vh]">
            {QUADRANTS.map(q => (
              <Quadrant
                key={q.id}
                quadrant={q}
                tasks={tasks
                  .filter(t => t.quadrant === q.id)
                  .sort((a, b) => a.order - b.order)
                }
                onAddTask={addTask}
                onToggleTask={toggleTask}
                onDeleteTask={deleteTask}
              />
            ))}
          </div>
        </DndContext>

        <footer className="mt-6 flex items-center justify-center gap-3 text-gray-600">
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
        </footer>
      </div>
    </div>
  )
}

function SignInScreen({ googleButtonRef, googleReady, hasClientId }) {
  return (
    <div className="min-h-[100dvh] bg-gray-50 px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:p-6">
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-gray-200 bg-white px-6 py-10 text-center shadow-sm">
        <h1 className="text-2xl font-semibold">Eisenhower Matrix</h1>
        <p className="text-sm text-gray-500">
          Sign in with Google to access your tasks.
        </p>

        <div className="mt-2 flex flex-col items-center gap-2">
          <div ref={googleButtonRef} />
          {!hasClientId && (
            <span className="text-[11px] text-gray-500">
              Set `VITE_GOOGLE_CLIENT_ID`
            </span>
          )}
          {hasClientId && !googleReady && (
            <span className="text-[11px] text-gray-500">
              Loading Google sign-in...
            </span>
          )}
        </div>
      </div>
    </div>
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
  onAddTask,
  onToggleTask,
  onDeleteTask,
}) 
 {
  const [input, setInput] = useState("")

  const { setNodeRef } = useDroppable({
    id: quadrant.id,
    data: { quadrant: quadrant.id },
  })

  const handleAdd = () => {
    onAddTask(input, quadrant.id)
    setInput("")
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-col md:min-h-[16rem]">
      <div className="mb-3">
        <h2 className="text-sm font-semibold sm:text-base">{quadrant.title}</h2>
        <p className="text-xs text-gray-500 sm:text-sm">{quadrant.subtitle}</p>
      </div>

      <SortableContext
        items={tasks.map(t => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className="flex-1 space-y-2 overflow-auto overscroll-contain"
        >
          {tasks.map(task => (
            <SortableTask
              key={task.id}
              task={task}
              onToggle={onToggleTask}
              onDelete={onDeleteTask}
            />
          ))}
        </div>
      </SortableContext>

      <div className="mt-3 flex gap-2">
        <input
          className="flex-1 rounded-md border px-3 py-2 text-sm sm:text-base"
          placeholder="Add task"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleAdd()}
        />
        <button
          onClick={handleAdd}
          className="px-4 py-2 border rounded-md text-sm sm:text-base"
          aria-label={`Add task to ${quadrant.title}`}
        >
          Add
        </button>
      </div>
    </div>
  )
}

function SortableTask({ task, onToggle, onDelete }) {
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-3 text-sm sm:text-base bg-white rounded-md px-3 py-2 border"
    >
      {/* Drag handle */}
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab text-gray-400 text-lg leading-none touch-none select-none"
        title="Drag"
      >
        ☰
      </span>

      {/* Checkbox */}
      <input
        type="checkbox"
        checked={task.completed}
        onChange={() => onToggle(task.id)}
        className="cursor-pointer h-4 w-4 sm:h-5 sm:w-5"
      />

      {/* Text */}
      <span
        className={`flex-1 ${
          task.completed ? "line-through text-gray-400" : ""
        }`}
      >
        {task.title}
      </span>

      {/* Delete */}
      <button
        onClick={() => onDelete(task.id)}
        className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-gray-400 hover:text-red-500 px-2 text-base"
        title="Delete"
        aria-label={`Delete ${task.title}`}
      >
        ✕
      </button>
    </div>
  )
}
