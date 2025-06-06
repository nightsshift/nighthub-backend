     const express = require('express');
     const cors = require('cors');
     const app = express();
     const port = process.env.PORT || 3000;

     // Middleware
     app.use(cors());
     app.use(express.json());

     // Sample courses data (replace with database later)
     const courses = [
       { id: 1, title: 'Life Skills 101', description: 'Learn budgeting, taxes, and more.' },
       { id: 2, title: 'Critical Thinking', description: 'Master problem-solving with AI.' },
     ];

     // Sample users storage (replace with database later)
     const users = [];

     // Routes
     app.get('/api/courses', (req, res) => {
       res.json(courses);
     });

     app.post('/api/register', (req, res) => {
       const { username, password } = req.body;
       if (!username || !password) {
         return res.status(400).json({ message: 'Username and password required' });
       }
       // Check for existing user (simplified)
       if (users.find(u => u.username === username)) {
         return res.status(400).json({ message: 'Username already exists' });
       }
       users.push({ username, password }); // Store in memory (replace with DB)
       res.json({ message: 'User registered successfully' });
     });

     app.listen(port, () => {
       console.log(`Server running on port ${port}`);
     });