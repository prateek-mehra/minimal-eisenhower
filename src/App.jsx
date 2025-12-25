import { useState } from "react"
import {
  DndContext,
  closestCenter,
  useDroppable,
} from "@dnd-kit/core"

import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable"

import { CSS } from "@dnd-kit/utilities"

const QUADRANTS = [
  { id: "UI", title: "Urgent & Important", subtitle: "Do first" },
  { id: "NI", title: "Not Urgent & Important", subtitle: "Schedule" },
  { id: "UN", title: "Urgent & Not Important", subtitle: "Delegate" },
  { id: "NN", title: "Not Urgent & Not Important", subtitle: "Eliminate" },
]

export default function App() {
  const [tasks, setTasks] = useState([])

  const addTask = (title, quadrant) => {
    if (!title.trim()) return

    setTasks(prev => [
      ...prev,
      {
        id: crypto.randomUUID(),
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
    <div className="min-h-screen bg-gray-50 p-6">
      <h1 className="text-2xl font-semibold mb-6">
        Eisenhower Matrix
      </h1>

      <DndContext
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-2 grid-rows-2 gap-4 h-[80vh]">
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
            />
          ))}
        </div>
      </DndContext>
    </div>
  )
}

function Quadrant({ quadrant, tasks, onAddTask, onToggleTask }) {
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
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-col">
      <div className="mb-3">
        <h2 className="text-sm font-semibold">{quadrant.title}</h2>
        <p className="text-xs text-gray-500">{quadrant.subtitle}</p>
      </div>

      <SortableContext
        items={tasks.map(t => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className="flex-1 space-y-2 overflow-auto"
        >
          {tasks.map(task => (
            <SortableTask
              key={task.id}
              task={task}
              onToggle={onToggleTask}
            />
          ))}
        </div>
      </SortableContext>

      <div className="mt-3 flex gap-2">
        <input
          className="flex-1 rounded-md border px-2 py-1 text-sm"
          placeholder="Add task"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleAdd()}
        />
        <button
          onClick={handleAdd}
          className="px-3 py-1 border rounded-md"
        >
          +
        </button>
      </div>
    </div>
  )
}

function SortableTask({ task, onToggle }) {
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
      className="flex items-center gap-2 text-sm bg-white rounded-md px-2 py-1 border"
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab text-gray-400"
      >
        ☰
      </span>

      <input
        type="checkbox"
        checked={task.completed}
        onChange={() => onToggle(task.id)}
      />

      <span
        className={`flex-1 ${
          task.completed ? "line-through text-gray-400" : ""
        }`}
      >
        {task.title}
      </span>
    </div>
  )
}
