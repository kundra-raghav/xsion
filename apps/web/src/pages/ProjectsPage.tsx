import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useAppStore } from '../store/useAppStore';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';
import { Plus, ExternalLink, FolderOpen } from 'lucide-react';
import { formatDateShort } from '../utils/format';
import './ProjectsPage.css';

// Form validation schema
const ProjectFormSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  baseUrl: z.string().url('Please enter a valid URL (e.g., https://example.com)'),
});

type ProjectFormData = z.infer<typeof ProjectFormSchema>;

export function ProjectsPage() {
  const navigate = useNavigate();
  const { projects, loadProjects, createProject } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formData, setFormData] = useState<ProjectFormData>({ name: '', baseUrl: '' });
  const [formErrors, setFormErrors] = useState<{ name?: string; baseUrl?: string }>({});

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await loadProjects();
      setLoading(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validateForm = (): boolean => {
    try {
      ProjectFormSchema.parse(formData);
      setFormErrors({});
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors: { name?: string; baseUrl?: string } = {};
        error.errors.forEach((err) => {
          const field = err.path[0] as 'name' | 'baseUrl';
          errors[field] = err.message;
        });
        setFormErrors(errors);
      }
      return false;
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    try {
      setCreating(true);
      await createProject(formData.name, formData.baseUrl);
      setShowCreateModal(false);
      setFormData({ name: '', baseUrl: '' });
      setFormErrors({});
    } catch (error) {
      // Error handled in store
    } finally {
      setCreating(false);
    }
  };

  const handleModalClose = () => {
    setShowCreateModal(false);
    setFormData({ name: '', baseUrl: '' });
    setFormErrors({});
  };

  const handleInputChange = (field: keyof ProjectFormData, value: string) => {
    setFormData({ ...formData, [field]: value });
    // Clear error for this field when user starts typing
    if (formErrors[field]) {
      setFormErrors({ ...formErrors, [field]: undefined });
    }
  };

  if (loading) {
    return (
      <div className="projects-page__loading">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="projects-page">
      <div className="projects-page__header">
        <h2>Projects</h2>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus size={16} />
          New Project
        </Button>
      </div>

      {loading ? (
        <div className="projects-page__loading">
          <Spinner size="lg" />
        </div>
      ) : projects.length === 0 ? (
        <div className="projects-page__empty">
          <FolderOpen size={64} strokeWidth={1.5} />
          <h3>No projects yet</h3>
          <p>Create your first project to start discovering and testing web applications</p>
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus size={16} />
            Create Your First Project
          </Button>
        </div>
      ) : (
        <div className="projects-page__grid">
          {projects.map((project) => (
            <Card
              key={project.id}
              variant="bordered"
              className="projects-page__card"
              onClick={() => navigate(`/projects/${project.id}`)}
            >
              <CardHeader>
                <div className="projects-page__card-header">
                  <h3>{project.name}</h3>
                </div>
              </CardHeader>
              <CardBody>
                <div className="projects-page__card-body">
                  <a
                    href={project.baseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="projects-page__url"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {project.baseUrl}
                    <ExternalLink size={14} />
                  </a>
                  <div className="projects-page__meta">
                    <span>Created: {formatDateShort(project.createdAt)}</span>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        isOpen={showCreateModal}
        onClose={handleModalClose}
        title="Create New Project"
        footer={
          <>
            <Button variant="secondary" onClick={handleModalClose}>
              Cancel
            </Button>
            <Button onClick={handleCreate} isLoading={creating}>
              Create
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreate}>
          <div className="projects-page__form">
            <Input
              label="Project Name"
              value={formData.name}
              onChange={(e) => handleInputChange('name', e.target.value)}
              placeholder="My Project"
              error={formErrors.name}
              required
            />
            <Input
              label="Base URL"
              type="text"
              value={formData.baseUrl}
              onChange={(e) => handleInputChange('baseUrl', e.target.value)}
              placeholder="https://example.com"
              error={formErrors.baseUrl}
              helperText="Enter the full URL including https://"
              required
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}
