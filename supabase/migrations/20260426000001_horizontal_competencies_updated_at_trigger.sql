CREATE TRIGGER update_horizontal_competencies_updated_at
BEFORE UPDATE ON public.horizontal_competencies
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
