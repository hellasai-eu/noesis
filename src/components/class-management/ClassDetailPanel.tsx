import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  School,
  BookOpen,
  Users,
  Trash2,
  Settings,
  UserPlus,
  Target,
  Power,
  Settings2,
  Loader2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import Student360 from "@/components/Student360";
import CourseInstructorPicker from "./CourseInstructorPicker";
import { getSectionDisplayName } from "@/lib/greek-school";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";
import type {
  ClassItem,
  ClassOffering,
  ClassEnrollment,
} from "./hooks/useClassManagement";

interface Props {
  selectedClass: ClassItem;
  classOfferings: ClassOffering[];
  classEnrollments: ClassEnrollment[];
  loadingClassDetails: boolean;
  isAdmin: boolean;
  onEnrollStudent: () => void;
  onDetachCourse: (offeringId: string) => void;
  onRemoveEnrollment: (userId: string) => void;
  onDeleteClass: (classId: string) => void;
  onToggleClassActive: (classId: string, currentActive: boolean) => void;
  onToggleSelfEnrollment: (classId: string, currentValue: boolean) => void;
  institutionId: string;
  onRemoveInstructor: (courseId: string, userId: string) => void;
  onInstructorAssigned: () => void;
  institutionAcademicPeriod?: string | null;
}

export default function ClassDetailPanel({
  selectedClass,
  classOfferings,
  classEnrollments,
  loadingClassDetails,
  isAdmin,
  onEnrollStudent,
  onDetachCourse,
  onRemoveEnrollment,
  onDeleteClass,
  onToggleClassActive,
  onToggleSelfEnrollment,
  institutionId,
  onRemoveInstructor,
  onInstructorAssigned,
  institutionAcademicPeriod,
}: Props) {
  const navigate = useNavigate();
  const [selectedOffering, setSelectedOffering] = useState<ClassOffering | null>(null);
  const [removingInstructor, setRemovingInstructor] = useState<string | null>(null);
  const [instructorPickerCourse, setInstructorPickerCourse] = useState<{
    id: string;
    title: string;
    instructorIds: string[];
  } | null>(null);
  const gradeLevels = useInstitutionGradeLevels(institutionId);

  const handleRemoveInstructor = async (courseId: string, userId: string) => {
    const key = `${courseId}-${userId}`;
    setRemovingInstructor(key);
    try {
      await onRemoveInstructor(courseId, userId);
    } finally {
      setRemovingInstructor(null);
    }
  };

  const gradeCode = gradeLevels.findCodeById(selectedClass.grade_level_id);
  const displayName = gradeCode && selectedClass.section_name
    ? `${gradeLevels.getLabel(gradeCode, "el")} - Τμήμα ${getSectionDisplayName(gradeCode, selectedClass.section_name)}${selectedClass.category ? ` (${selectedClass.category})` : ""}`
    : selectedClass.name;

  if (loadingClassDetails) {
    return (
      <Card>
        <CardContent className="py-16 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <School className="w-5 h-5" />
              {displayName}
              {!selectedClass.is_active && (
                <Badge variant="secondary" className="ml-2">
                  Inactive
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {selectedClass.academic_period || institutionAcademicPeriod || "No academic period set"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-2">
                      <Power
                        className={`w-4 h-4 ${selectedClass.is_active ? "text-green-500" : "text-muted-foreground"}`}
                      />
                      <Switch
                        checked={selectedClass.is_active}
                        onCheckedChange={() =>
                          onToggleClassActive(selectedClass.id, selectedClass.is_active)
                        }
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    {selectedClass.is_active ? "Deactivate class" : "Activate class"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive hover:text-destructive"
              onClick={() => onDeleteClass(selectedClass.id)}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="courses" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="enrollments" className="flex items-center gap-2">
              <Users className="w-4 h-4" />
              Students ({classEnrollments.filter(e => e.role === "student").length})
            </TabsTrigger>
            <TabsTrigger value="courses" className="flex items-center gap-2">
              <BookOpen className="w-4 h-4" />
              Courses ({classOfferings.length})
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="settings" className="flex items-center gap-2">
                <Settings2 className="w-4 h-4" />
                Settings
              </TabsTrigger>
            )}
          </TabsList>

          {/* Students Tab */}
          <TabsContent value="enrollments">
            <div className="space-y-4">
              <div className="flex justify-end gap-2">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          size="sm"
                          onClick={onEnrollStudent}
                          disabled={!selectedClass.is_active}
                        >
                          <UserPlus className="w-4 h-4 mr-2" />
                          Add Student
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!selectedClass.is_active && (
                      <TooltipContent>Cannot enroll students in inactive class</TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              </div>
              {classEnrollments.filter(e => e.role === "student").length === 0 ? (
                <div className="text-center py-8 border-2 border-dashed rounded-lg">
                  <Users className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground mb-4">No students enrolled yet</p>
                  {selectedClass.is_active ? (
                    <div className="flex justify-center gap-2">
                      <Button variant="outline" size="sm" onClick={onEnrollStudent}>
                        <UserPlus className="w-4 h-4 mr-2" />
                        Add First Student
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Activate this class to enroll users
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {classEnrollments
                  .filter((enrollment) => enrollment.role === "student")
                  .map((enrollment) => (
                    <div
                      key={enrollment.user_id}
                      className="flex items-center justify-between p-3 rounded-lg bg-secondary/50"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-green-500/10">
                          <Users className="w-4 h-4 text-green-500" />
                        </div>
                        <div>
                          <p className="font-medium text-sm">
                            {enrollment.full_name || enrollment.email || "Unknown User"}
                          </p>
                          {enrollment.full_name && enrollment.email && (
                            <p className="text-xs text-muted-foreground">{enrollment.email}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-xs">
                          <Users className="w-3 h-3 text-green-500 mr-1" />
                          Student
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => onRemoveEnrollment(enrollment.user_id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* Courses Tab */}
          <TabsContent value="courses">
            <div className="space-y-4">
              {classOfferings.length === 0 ? (
                <div className="text-center py-8 border-2 border-dashed rounded-lg">
                  <BookOpen className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">
                    No courses attached yet. Manage courses from the grade level view.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {classOfferings.map((offering) => (
                    <div key={offering.id} className="rounded-lg bg-secondary/50 overflow-hidden">
                      <div className="flex items-center justify-between p-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                            <BookOpen className="w-4 h-4 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium text-sm">{offering.course_title}</p>
                            <Badge
                              variant={offering.is_active ? "default" : "secondary"}
                              className="text-xs mt-1"
                            >
                              {offering.is_active ? "Active" : "Inactive"}
                            </Badge>
                            {offering.instructors.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {offering.instructors.map((inst) => {
                                  const instructorKey = `${offering.course_id}-${inst.user_id}`;
                                  return (
                                    <Badge key={inst.user_id} data-testid="instructor-badge" variant="outline" className="text-xs py-0 px-1.5 flex items-center gap-1">
                                      {inst.full_name || inst.email || "Unknown"}
                                      {isAdmin && (
                                        <button
                                          className="ml-0.5 hover:text-destructive disabled:opacity-50"
                                          disabled={removingInstructor === instructorKey}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleRemoveInstructor(offering.course_id, inst.user_id);
                                          }}
                                        >
                                          {removingInstructor === instructorKey ? (
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                          ) : (
                                            <X className="w-3 h-3" />
                                          )}
                                        </button>
                                      )}
                                    </Badge>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isAdmin && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() =>
                                setInstructorPickerCourse({
                                  id: offering.course_id,
                                  title: offering.course_title,
                                  instructorIds: offering.instructors.map((i) => i.user_id),
                                })
                              }
                            >
                              <UserPlus className="w-3.5 h-3.5 mr-1" />
                              Add Instructor
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSelectedOffering(offering)}
                          >
                            <Target className="w-3 h-3 mr-1" />
                            Student 360
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => navigate(`/course/${offering.course_id}`)}
                          >
                            <Settings className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => onDetachCourse(offering.id)}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                      {selectedOffering?.id === offering.id && (
                        <div className="border-t p-4 bg-background/50">
                          <div className="flex items-center justify-between mb-4">
                            <h4 className="font-medium flex items-center gap-2">
                              <Target className="w-4 h-4" />
                              Student 360 - {offering.course_title}
                            </h4>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSelectedOffering(null)}
                            >
                              Close
                            </Button>
                          </div>
                          <Student360 courseId={offering.course_id} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* Settings Tab */}
          {isAdmin && (
            <TabsContent value="settings">
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/50">
                  <div className="flex items-center gap-4">
                    <div
                      className={`w-10 h-10 rounded-lg flex items-center justify-center ${selectedClass.allow_self_enrollment ? "bg-green-500/20" : "bg-muted"}`}
                    >
                      <UserPlus
                        className={`w-5 h-5 ${selectedClass.allow_self_enrollment ? "text-green-600" : "text-muted-foreground"}`}
                      />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Allow Self-Enrollment</p>
                      <p className="text-sm text-muted-foreground">
                        {selectedClass.allow_self_enrollment
                          ? "Students can browse and enroll in this class"
                          : "Only admins can enroll students"}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={selectedClass.allow_self_enrollment}
                    onCheckedChange={() =>
                      onToggleSelfEnrollment(selectedClass.id, selectedClass.allow_self_enrollment)
                    }
                    disabled={!selectedClass.is_active}
                  />
                </div>
                {!selectedClass.is_active && (
                  <p className="text-sm text-muted-foreground text-center">
                    Activate this class to enable self-enrollment settings
                  </p>
                )}
              </div>
            </TabsContent>
          )}
        </Tabs>
      </CardContent>

      {instructorPickerCourse && (
        <CourseInstructorPicker
          open={!!instructorPickerCourse}
          onOpenChange={(open) => {
            if (!open) setInstructorPickerCourse(null);
          }}
          courseId={instructorPickerCourse.id}
          courseTitle={instructorPickerCourse.title}
          institutionId={institutionId}
          currentInstructorIds={instructorPickerCourse.instructorIds}
          onChanged={onInstructorAssigned}
        />
      )}
    </Card>
  );
}
