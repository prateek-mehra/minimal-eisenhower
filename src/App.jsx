import { useState, useEffect } from "react"
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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
  }, [tasks])

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

    setTasks(prev => [
      ...prev,
      {
        id: generateId(),
        title,
        quadrant,
        completed: false,
        order: prev.filter(t => t.quadrant === quadrant).length,
      },
    ])
  }

  const toggleTask = (id) => {
    setTasks(prev =>
      prev.map(t =>
        t.id === id ? { ...t, completed: !t.completed } : t
      )
    )
  }

  const deleteTask = (id) => {
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  const clearCompleted = () => {
    setTasks(prev => prev.filter(t => !t.completed))
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

    setTasks(prev => {
      const sourceTasks = prev
        .filter(t => t.quadrant === sourceQuadrant && t.id !== active.id)
        .sort((a, b) => a.order - b.order)
        .map((t, i) => ({ ...t, order: i }))

      const targetTasks = prev
        .filter(t => t.quadrant === targetQuadrant)
        .sort((a, b) => a.order - b.order)

      const movedTask = {
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
  }

  return (
    <div className="min-h-[100dvh] bg-gray-50 px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:p-6">
      <div className="mx-auto w-full max-w-5xl">
        <div className="sticky top-0 z-10 -mx-4 mb-4 bg-gray-50/95 px-4 pb-3 pt-4 backdrop-blur sm:static sm:mx-0 sm:mb-6 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold sm:text-2xl">
              Eisenhower Matrix
            </h1>

            <button
              onClick={clearCompleted}
              className="text-xs sm:text-sm px-3 py-2 rounded-md border border-gray-300 hover:bg-gray-100"
            >
              Clear completed
            </button>
          </div>
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
