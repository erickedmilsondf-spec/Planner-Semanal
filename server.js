const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Banco de dados SQLite
const db = new sqlite3.Database(path.join(__dirname, 'planner.db'), (err) => {
  if (err) console.error('Erro ao conectar ao banco:', err);
  else console.log('Conectado ao banco SQLite');
});

// Criar tabela se não existir
db.run(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    completed BOOLEAN DEFAULT 0,
    postponed INTEGER DEFAULT 0,
    createdDate TEXT NOT NULL,
    updatedDate TEXT NOT NULL
  )
`);

// Helper para converter data para string ISO
function dateToISO(date) {
  return date.toISOString().split('T')[0];
}

// Função para mover tarefas não concluídas para a próxima semana
function postponeUncompletedTasks() {
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const startDate = dateToISO(weekStart);
  const endDate = dateToISO(weekEnd);
  const nextWeekStart = dateToISO(new Date(weekEnd.getTime() + 86400000)); // Próxima segunda

  db.all(
    `SELECT * FROM tasks WHERE completed = 0 AND date >= ? AND date <= ?`,
    [startDate, endDate],
    (err, rows) => {
      if (err) console.error('Erro ao buscar tarefas:', err);
      else {
        rows.forEach((task) => {
          const newDate = new Date(nextWeekStart);
          db.run(
            `UPDATE tasks SET date = ?, postponed = postponed + 1, updatedDate = ? WHERE id = ?`,
            [dateToISO(newDate), new Date().toISOString(), task.id],
            (err) => {
              if (err) console.error('Erro ao adiar tarefa:', err);
            }
          );
        });
      }
    }
  );
}

// Rotina para verificar e adiar tarefas toda semana
setInterval(() => {
  const today = new Date();
  // Rodar toda segunda-feira às 00:00
  if (today.getDay() === 1 && today.getHours() === 0) {
    postponeUncompletedTasks();
  }
}, 60000); // Verificar a cada minuto

// ====== ROTAS API ======

// GET - Listar tarefas
app.get('/api/tasks', (req, res) => {
  db.all('SELECT * FROM tasks ORDER BY date ASC', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// POST - Criar nova tarefa
app.post('/api/tasks', (req, res) => {
  const { title, date, category } = req.body;

  if (!title || !date || !category) {
    res.status(400).json({ error: 'Título, data e categoria são obrigatórios' });
    return;
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO tasks (id, title, date, category, createdDate, updatedDate) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, title, date, category, now, now],
    function (err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.status(201).json({ id, title, date, category, completed: false, postponed: 0 });
    }
  );
});

// PATCH - Atualizar tarefa (marcar como concluída ou adiar)
app.patch('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const { completed, action } = req.body;

  if (action === 'postpone') {
    // Adiar para próxima semana
    db.get('SELECT date FROM tasks WHERE id = ?', [id], (err, row) => {
      if (err || !row) {
        res.status(404).json({ error: 'Tarefa não encontrada' });
        return;
      }

      const currentDate = new Date(row.date);
      currentDate.setDate(currentDate.getDate() + 7);
      const newDate = dateToISO(currentDate);

      db.run(
        `UPDATE tasks SET date = ?, postponed = postponed + 1, updatedDate = ? WHERE id = ?`,
        [newDate, new Date().toISOString(), id],
        function (err) {
          if (err) {
            res.status(500).json({ error: err.message });
            return;
          }
          res.json({ success: true, newDate });
        }
      );
    });
  } else if (typeof completed === 'boolean') {
    // Marcar como concluída/não concluída
    db.run(
      `UPDATE tasks SET completed = ?, updatedDate = ? WHERE id = ?`,
      [completed ? 1 : 0, new Date().toISOString(), id],
      function (err) {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        res.json({ success: true, completed });
      }
    );
  } else {
    res.status(400).json({ error: 'Ação inválida' });
  }
});

// DELETE - Deletar tarefa
app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM tasks WHERE id = ?', [id], function (err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true });
  });
});

// GET - Estatísticas da semana
app.get('/api/stats', (req, res) => {
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const startDate = dateToISO(weekStart);
  const endDate = dateToISO(weekEnd);

  db.get(
    `SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END) as pending
    FROM tasks 
    WHERE date >= ? AND date <= ?`,
    [startDate, endDate],
    (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json(row);
    }
  );
});

// Rota para servir o frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📋 Acesse o planner em http://localhost:${PORT}`);
});
