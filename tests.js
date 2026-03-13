const request = require('supertest');
const app = require('../app');  // Adjust path as necessary

// Unit tests for authentication
describe('Authentication Tests', () => {
    it('should register a new user', async () => {
        const response = await request(app)
            .post('/api/auth/register')
            .send({ username: 'testuser', password: 'password123' });
        expect(response.status).toBe(201);
        expect(response.body).toHaveProperty('token');
    });

    it('should login an existing user', async () => {
        const response = await request(app)
            .post('/api/auth/login')
            .send({ username: 'testuser', password: 'password123' });
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('token');
    });
});

// Integration tests for article management
describe('Article Management Tests', () => {
    let token;

    beforeAll(async () => {
        // Register and login to obtain a token
        const response = await request(app)
            .post('/api/auth/login')
            .send({ username: 'testuser', password: 'password123' });
        token = response.body.token;
    });

    it('should create a new article', async () => {
        const response = await request(app)
            .post('/api/articles')
            .set('Authorization', `Bearer ${token}`)
            .send({ title: 'New Article', content: 'Article content goes here' });
        expect(response.status).toBe(201);
        expect(response.body).toHaveProperty('id');
    });

    it('should get all articles', async () => {
        const response = await request(app)
            .get('/api/articles');
        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBeTrue();
    });

    it('should update an article', async () => {
        const articleId = 1; // Replace with actual article ID
        const response = await request(app)
            .put(`/api/articles/${articleId}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ title: 'Updated Article', content: 'Updated content' });
        expect(response.status).toBe(200);
    });

    it('should delete an article', async () => {
        const articleId = 1; // Replace with actual article ID
        const response = await request(app)
            .delete(`/api/articles/${articleId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(response.status).toBe(204);
    });
});

// Integration tests for user management
describe('User Management Tests', () => {
    it('should retrieve user information', async () => {
        const response = await request(app)
            .get('/api/users/me')
            .set('Authorization', `Bearer ${token}`);
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('username');
    });
});

// Integration tests for API endpoints
describe('API Endpoint Tests', () => {
    it('should get a health check', async () => {
        const response = await request(app)
            .get('/api/health');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: 'OK' });
    });
});