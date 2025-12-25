import { useState } from "react"
import {
  DndContext,
  closestCenter,
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
  order: tasks.filter(t => t.quadrant === quadrant).length,

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

  // reassign order explicitly
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




  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <h1 className="text-2xl font-semibold mb-6">
        Eisenhower Matrix
      </h1>

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
            onReorder={reorderTasks}
          />
        ))}
      </div>
    </div>
  )
}

function Quadrant({ quadrant, tasks, onAddTask, onToggleTask, onReorder })
 {
  const [input, setInput] = useState("")

  const handleAdd = () => {
    onAddTask(input, quadrant.id)
    setInput("")
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-col">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-gray-900">
          {quadrant.title}
        </h2>
        <p className="text-xs text-gray-500">
          {quadrant.subtitle}
        </p>
      </div>

      {/* Task list */}
      <DndContext
  collisionDetection={closestCenter}
  onDragEnd={(event) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = tasks.findIndex(t => t.id === active.id)
    const newIndex = tasks.findIndex(t => t.id === over.id)

    onReorder(tasks, oldIndex, newIndex)
  }}
>
  <SortableContext
    items={tasks.map(t => t.id)}
    strategy={verticalListSortingStrategy}
  >
    <div className="flex-1 space-y-2 overflow-auto">
      {tasks.map(task => (
        <SortableTask
          key={task.id}
          task={task}
          onToggle={onToggleTask}
        />
      ))}
    </div>
  </SortableContext>
</DndContext>


      {/* Add task input */}
      <div className="mt-3 flex gap-2">
        <input
          className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
          placeholder="Add task"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleAdd()}
        />
        <button
          onClick={handleAdd}
          className="text-sm px-3 py-1 rounded-md border border-gray-300 hover:bg-gray-100"
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
  } = useSortable({ id: task.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 text-sm bg-white rounded-md px-2 py-1 border border-gray-200"
    >
      {/* Drag handle */}
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab text-gray-400 px-1"
        title="Drag"
      >
        ☰
      </span>

      {/* Checkbox */}
      <input
        type="checkbox"
        checked={task.completed}
        onChange={() => onToggle(task.id)}
        className="cursor-pointer"
      />

      {/* Text */}
      <span
        className={`flex-1 select-none ${
          task.completed
            ? "line-through text-gray-400"
            : "text-gray-800"
        }`}
      >
        {task.title}
      </span>
    </div>
  )
}
