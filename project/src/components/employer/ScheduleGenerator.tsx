// src/components/employer/ScheduleGenerator.tsx
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';
import { toast } from 'react-hot-toast';
import {
    Calendar as CalendarIconLucide, Users, Clock, Save, AlertTriangle, Loader2, Plus, Trash2,
    UserPlus, Settings, Edit, Download, List, X, Calendar as FullCalendarIcon, UploadCloud,
    ChevronDown, UserCheck, UserX, Info, Repeat, CheckSquare, Square, Printer, Megaphone, ChevronLeft, ChevronRight, Image as ImageIcon
} from 'lucide-react';
import type { UserProfile, UserRole, ShiftNeed } from '../../types';
import type { Database } from '../../types/database';
import autoTable from 'jspdf-autotable';

// FullCalendar Imports
import { Calendar } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import fcSvLocale from '@fullcalendar/core/locales/sv';

// Date-fns Imports
import { format, parseISO, isValid } from 'date-fns';
import { startOfWeek, endOfWeek, addDays, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay } from 'date-fns';
import { sv } from 'date-fns/locale';

// Modal Imports
import { ShiftDetailsModal } from '../Shifts/ShiftDetailsModal';

import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

// Helper function to get a random color for styling
const getColor = (str: string) => {
    let hash = 0;
    if (!str || str.length === 0) {
        return '6B7280'; // A default gray color
    }
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return "00000".substring(0, 6 - c.length) + c;
};

// --- Interfaces ---
interface ScheduleRequirement { id: string; daysOfWeek: number[]; startTime: string; endTime: string; requiredRole: UserRole | ''; requiredCount: number; includeLunch: boolean; }
type ManualStaffMember = Database['public']['Tables']['employer_manual_staff']['Row'];

// NEW: Represents an employee fetched from your database via the relationship table
interface EmployedStaffProfile {
  id: string; // This is the profile_id
  name: string;
  role: UserRole;
  // Add other relevant fields from your 'profiles' table here
}

// NEW: This will be the unified structure for ALL staff in the schedule (manual or employed)
interface ScheduleStaffMember {
    id: string; // Can be profile_id or manual_staff_id
    name: string;
    role: UserRole;
    minstaAntalTimmar: number;
    anstallningstyp: 'Heltid' | 'Deltid' | 'Timmar'; // Or other types you use
    maxConsecutiveDays: number | null;
    isManual: boolean; // Flag to distinguish between staff types
}

interface GeneratedShift {
    id: string;
    date: string;
    start_time: string;
    end_time: string;
    required_role: UserRole;
    employer_id?: string;
    title?: string;
    description?: string;
    lunch?: string | null;
    location?: string | null;
    status?: 'open' | 'filled';
    assigned_employee_id?: string | null;
    assigned_employee_name?: string | null;
    is_unfilled: boolean;
    is_manually_added?: boolean;
    notes?: string;
    is_urgent?: boolean;
    urgent_pay_adjustment?: number | null;
    required_experience?: string[] | null;
    lunch_duration_minutes?: number | null;
    published_shift_need_id?: string | null;
}

interface PharmacyHours { dayOfWeek: number; openTime: string | null; closeTime: string | null; }
type ScheduleRecord = Database['public']['Tables']['schedules']['Row'];
type ScheduleShiftRecord = Database['public']['Tables']['schedule_shifts']['Row'];
type ScheduleShiftRecordUpsert = Omit<Database['public']['Tables']['schedule_shifts']['Row'], 'id' | 'created_at' | 'updated_at'> & { id?: string };


const DAYS_OF_WEEK_NAMES_SV = ['Söndag', 'Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag'];
const ALL_ROLES: UserRole[] = ['pharmacist', 'säljare', 'egenvårdsrådgivare'];
const ROLE_DISPLAY_MAP: Record<UserRole, string> = {
  pharmacist: 'Farmaceut',
  säljare: 'Säljare',
  egenvårdsrådgivare: 'Egenvårdsrådgivare'
};
function formatTime(timeString: string | null | undefined): string {
    if (!timeString) return 'N/A';
    const parts = timeString.split(':');
    if (parts.length >= 2) {
        return `${parts[0]}:${parts[1]}`;
    }
    return 'Invalid time';
}

export function ScheduleGenerator() {
    const { profile } = useAuth();
    const [manualStaffList, setManualStaffList] = useState<ManualStaffMember[]>([]);
    const [loadingStaff, setLoadingStaff] = useState(false);
    const [newStaffName, setNewStaffName] = useState('');
    const [newStaffRole, setNewStaffRole] = useState<UserRole | ''>('');
    const [scheduleRequirements, setScheduleRequirements] = useState<ScheduleRequirement[]>([]);
    // --- NEW STATE for combined staff management ---
    
    // Holds employees fetched from your DB (employer_employee_relationship)
    const [employedStaffList, setEmployedStaffList] = useState<EmployedStaffProfile[]>([]);
    
    // THIS IS THE NEW MASTER LIST for staff to be scheduled. It combines both types.
    const [scheduleStaffList, setScheduleStaffList] = useState<ScheduleStaffMember[]>([]);
    
    // Manages the modal for adding employed staff
    const [isStaffModalOpen, setIsStaffModalOpen] = useState(false);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [pharmacyHours, setPharmacyHours] = useState<PharmacyHours[]>(DAYS_OF_WEEK_NAMES_SV.map((_, i) => ({ dayOfWeek: i, openTime: '09:00', closeTime: '18:00' })));
    const [defaultLunchMinutes, setDefaultLunchMinutes] = useState<number>(30);
  const [postShiftHourlyRate, setPostShiftHourlyRate] = useState<number | null>(null);
  const [postShiftLunch, setPostShiftLunch] = useState<string>('30 min'); // Default to 30 min
    const [minStaffingRules, setMinStaffingRules] = useState<{ id: string; role: UserRole | ''; count: number }[]>([]);
    const [generatedSchedule, setGeneratedSchedule] = useState<GeneratedShift[] | null>(null);
    const [displaySchedule, setDisplaySchedule] = useState<GeneratedShift[] | null>(null);
    const [loadingGeneration, setLoadingGeneration] = useState(false);
    const [savingSchedule, setSavingSchedule] = useState(false);
    const [publishingShifts, setPublishingShifts] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [scheduleView, setScheduleView] = useState<'list' | 'calendar'>('list');
    const calendarRef = useRef<HTMLDivElement>(null);
    const calendarInstanceRef = useRef<Calendar | null>(null);
    const [scheduleName, setScheduleName] = useState('');
    const [savedScheduleId, setSavedScheduleId] = useState<string | null>(null);
    const [editingShiftId, setEditingShiftId] = useState<string | null>(null);
    const [savedSchedulesList, setSavedSchedulesList] = useState<ScheduleRecord[]>([]);
    const [loadingSavedSchedules, setLoadingSavedSchedules] = useState(false);
    const [showLoadScheduleModal, setShowLoadScheduleModal] = useState(false);
    const [showPostShiftModal, setShowPostShiftModal] = useState(false);
    const [shiftToPost, setShiftToPost] = useState<GeneratedShift | null>(null);
    const [postShiftIsUrgent, setPostShiftIsUrgent] = useState(false);
    const [postShiftUrgentAdjustment, setPostShiftUrgentAdjustment] = useState<number | null>(null);
    const [postShiftTitle, setPostShiftTitle] = useState('');
    const [postShiftDescription, setPostShiftDescription] = useState('');
    const [shiftToEdit, setShiftToEdit] = useState<GeneratedShift | null>(null);
    const [showShiftDetailsModal, setShowShiftDetailsModal] = useState(false);
  const scheduleViewRef = useRef<HTMLDivElement>(null);
const listViewRef = useRef<HTMLDivElement>(null);



    const fetchManualStaff = useCallback(async () => {
        if (!profile?.id) return;
        setLoadingStaff(true);
        setError(null);
        try {
            const { data, error: fetchError } = await supabase
                .from('employer_manual_staff')
                .select('*')
                .eq('employer_id', profile.id)
                .order('staff_name', { ascending: true });
            if (fetchError) throw fetchError;
            setManualStaffList(data || []);
            
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to load staff list.";
            console.error("Error fetching staff:", err);
            toast.error(message);
            setError(message);
            setManualStaffList([]);
        } finally {
            setLoadingStaff(false);
        }
    }, [profile]);

    useEffect(() => {
        fetchManualStaff();
    }, [fetchManualStaff]);
  const fetchEmployedStaff = useCallback(async () => {
        if (!profile?.id) return;

        try {
            // This query joins through the relationship table to get profile details
            const { data, error: fetchError } = await supabase
    .from('employer_employee_relationships')
    // This is the corrected line:
    .select(`
        profiles!employer_employee_relationships_employee_id_fkey (
            id,
            full_name,
            role
        )
    `)
    .eq('employer_id', profile.id);

            if (fetchError) throw fetchError;

            // The data is nested, so we flatten it to our EmployedStaffProfile interface
            const profiles = data?.map(item => {
    if (!item.profiles) return null;
    return {
        id: item.profiles.id,
        name: item.profiles.full_name, // <-- Map full_name to name
        role: item.profiles.role,
    };
}).filter(p => p) || [];

setEmployedStaffList(profiles as EmployedStaffProfile[]);

        } catch (err) {
            console.error("Error fetching employed staff:", err);
            toast.error("Could not load your list of employees.");
        }
    }, [profile]);

    // Call this new fetch function in a useEffect
    useEffect(() => {
        if (profile?.id) {
            fetchManualStaff();
            fetchEmployedStaff(); // Fetch both lists on load
        }
    }, [profile, fetchManualStaff, fetchEmployedStaff]);

  // NEW: Effect to synchronize fetched staff into the main schedule list
useEffect(() => {
    // Convert fetched manual staff to the unified ScheduleStaffMember format
    const formattedManualStaff = manualStaffList.map(manual => ({
        id: manual.id,
        name: manual.staff_name,
        role: manual.staff_role as UserRole,
        minstaAntalTimmar: manual.target_hours || 40,
        anstallningstyp: 'Heltid', // Assuming a default, adjust if you save this
        maxConsecutiveDays: manual.max_consecutive_days || 5,
        isManual: true,
    }));

    // Convert fetched employed staff to the unified ScheduleStaffMember format
    const formattedEmployedStaff = employedStaffList.map(employed => ({
        id: employed.id,
        name: employed.name,
        role: employed.role,
        minstaAntalTimmar: 40, // Default value
        anstallningstyp: 'Heltid', // Default value
        maxConsecutiveDays: 5, // Default value
        isManual: false,
    }));

    // Combine them, preventing duplicates
    const allStaff = [...formattedEmployedStaff, ...formattedManualStaff];
    const uniqueStaff = allStaff.filter((staff, index, self) =>
        index === self.findIndex((s) => s.id === staff.id)
    );

    setScheduleStaffList(uniqueStaff);

}, [manualStaffList, employedStaffList]); // This runs whenever the fetched lists change

    const handleAddStaffMember = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newStaffName.trim() || !newStaffRole || !profile?.id) {
            toast.error("Name and role are required.");
            return;
        }
        const tid = toast.loading("Adding staff member...");
        try {
            const { data, error } = await supabase
                .from('employer_manual_staff')
                .insert({
                    employer_id: profile.id,
                    staff_name: newStaffName.trim(),
                    staff_role: newStaffRole,
                    target_hours_type: 'week',
                    target_hours: 40,
                    max_consecutive_days: 5,
                })
                .select()
                .single();
            if (error) throw error;
           if (data) {
    // Add to the old list (for now, to keep other logic working)
    setManualStaffList(prev => [...prev, data]);

    // ALSO add to the NEW unified list
    const newScheduleMember: ScheduleStaffMember = {
        id: data.id,
        name: data.staff_name,
        role: data.staff_role,
        minstaAntalTimmar: 40, // Default value
        anstallningstyp: 'Heltid', // Default value
        maxConsecutiveDays: 5, // Default value
        isManual: true, // Mark as manual
    };
    setScheduleStaffList(prev => [...prev, newScheduleMember]);

    setNewStaffName('');
    setNewStaffRole('');
    toast.success("Staff member added.", { id: tid });
} else {
                throw new Error("Failed to add staff member (no data returned).");
            }
        } catch (err) {
            console.error("Error adding staff:", err);
            toast.error(err instanceof Error ? err.message : "Failed to add staff.", { id: tid });
        }
    }, [newStaffName, newStaffRole, profile?.id]);

    const handleRemoveStaffMember = useCallback(async (idToRemove: string) => {
        if (!window.confirm("Are you sure you want to remove this staff member? This action cannot be undone.")) return;
        const tid = toast.loading("Removing staff member...");
        try {
            const { error } = await supabase.from('employer_manual_staff').delete().eq('id', idToRemove);
            if (error) throw error;
            setManualStaffList(prev => prev.filter(staff => staff.id !== idToRemove));
           
            toast.success("Staff member removed.", { id: tid });
        } catch (err) {
            console.error("Error removing staff:", err);
            toast.error(err instanceof Error ? err.message : "Failed to remove staff.", { id: tid });
        }
    }, []);

    const handleStaffConstraintChange = useCallback(async (
        staffId: string,
        field: keyof Omit<ScheduleStaffMember, 'id' | 'name' | 'role' | 'isManual'>,
        value: any
    ) => {
        setScheduleStaffList(prev =>
        prev.map(staff => {
            if (staff.id === staffId) {
                let processedValue = value;
                if (field === 'minstaAntalTimmar' || field === 'maxConsecutiveDays') {
                    processedValue = value === '' ? null : (parseInt(value, 10) || null);
                }
                return { ...staff, [field]: processedValue };
            }
            return staff;
        })
    );
    // You can add a debounced save to Supabase here if you store these settings per-schedule
}, []);

    const handleAddRequirement = () => setScheduleRequirements(prev => [...prev, { id: crypto.randomUUID(), daysOfWeek: [], startTime: '09:00', endTime: '17:00', requiredRole: '', requiredCount: 1, includeLunch: true }]);
    const handleRequirementChange = (id: string, field: keyof ScheduleRequirement | 'dayOfWeekToggle', value: any) => {
        setScheduleRequirements(prev => prev.map(req => {
            if (req.id === id) {
                if (field === 'dayOfWeekToggle') {
                    const dayIndex = value as number;
                    const currentDays = req.daysOfWeek || [];
                    const newDays = currentDays.includes(dayIndex) ? currentDays.filter(d => d !== dayIndex) : [...currentDays, dayIndex].sort((a, b) => a - b);
                    return { ...req, daysOfWeek: newDays };
                } else if (field === 'requiredCount') {
                    return { ...req, [field]: Math.max(1, (parseInt(value, 10) || 1)) };
                } else {
                    return { ...req, [field]: value };
                }
            }
            return req;
        }));
    };
    const handleRemoveRequirement = (id: string) => setScheduleRequirements(prev => prev.filter(req => req.id !== id));
    const handlePharmacyHourChange = (dayIndex: number, field: 'openTime' | 'closeTime', value: string | null) => {
        setPharmacyHours(prev => prev.map((day, i) => i === dayIndex ? { ...day, [field]: value === '' ? null : value } : day));
    };
  const [defaultHourlyRate, setDefaultHourlyRate] = useState<number>(200); // Or any default
  
    const handleAddMinStaffingRule = () => setMinStaffingRules(prev => [...prev, { id: crypto.randomUUID(), role: '', count: 1 }]);
    const handleMinStaffingChange = (id: string, field: 'role' | 'count', value: any) => {
        const updatedValue = field === 'count' ? Math.max(1, (parseInt(value, 10) || 1)) : value;
        setMinStaffingRules(prev => prev.map(rule => rule.id === id ? { ...rule, [field]: updatedValue } : rule));
    };
    const handleRemoveMinStaffingRule = (id: string) => setMinStaffingRules(prev => prev.filter(rule => rule.id !== id));

    const handleGenerateSchedule = useCallback(async () => {
        setError(null); setWarnings([]); setGeneratedSchedule(null); setDisplaySchedule(null);
        setSavedScheduleId(null); setEditingShiftId(null);

        if (!startDate || !endDate) { toast.error("Please select a start and end date."); return; }
        const hasValidRequirements = scheduleRequirements.length > 0 && scheduleRequirements.some(req => req.daysOfWeek.length > 0 && req.requiredRole && req.requiredCount > 0);
        const hasMinStaffing = minStaffingRules.length > 0 && minStaffingRules.some(rule => rule.role && rule.count > 0);
        if (!hasValidRequirements && !hasMinStaffing) { toast.error("Please define staffing needs or minimum staffing rules."); return; }
       if (scheduleStaffList.length === 0) {
        toast.error("Please add staff to include in the schedule.");
        return;
    }

        setLoadingGeneration(true);
        const tid = toast.loading("Generating schedule...");
        try {
           const validRequirements = scheduleRequirements.filter(req => req.daysOfWeek.length > 0 && req.requiredRole && req.requiredCount > 0);
        const validMinStaffing = minStaffingRules.filter(r => r.role && r.count > 0);

const employeesForGeneration = scheduleStaffList.map(staff => {
            // This now correctly maps our unified state to the format the Edge Function needs
            return {
                id: staff.id,
                name: staff.name,
                role: staff.role,
                minstaAntalTimmar: staff.minstaAntalTimmar || 0, // Ensure it's not null/undefined
                anstallningstyp: staff.anstallningstyp || 'Timmar', // Ensure a default
                constraints: {
                    maxConsecutiveDays: staff.maxConsecutiveDays,
                },
            };
        });
           

           const payload = {
            startDate,
            endDate,
            pharmacyHours,
            requirements: validRequirements,
            employees: employeesForGeneration, // Use the new list here
            rules: { defaultLunchMinutes, minStaffing: validMinStaffing }
        };
            const { data, error: functionError } = await supabase.functions.invoke('generate-schedule', { body: payload });

            if (functionError) {
                let errMsg = functionError.message || "Failed to invoke schedule generation.";
                if (functionError.context?.error?.message) errMsg = `Function error: ${functionError.context.error.message}`;
                else if (typeof functionError.context === 'string') errMsg = `Function context error: ${functionError.context}`;
                throw new Error(errMsg);
            }
            if (data?.error) { throw new Error(data.error); }
            if (!data?.schedule) { throw new Error("Generation did not return valid schedule data."); }

            const scheduleWithClientIdsAndNames: GeneratedShift[] = (data.schedule || []).map((shift: Omit<GeneratedShift, 'id' | 'assigned_employee_name' | 'is_manually_added'>) => ({
                ...shift,
                id: crypto.randomUUID(),
               assigned_employee_name: shift.assigned_employee_id ? scheduleStaffList.find(s => s.id === shift.assigned_employee_id)?.name || 'Unknown Staff' : undefined,
                is_manually_added: false,
                lunch: shift.lunch_duration_minutes ? `PT${shift.lunch_duration_minutes}M` : null,
            }));

            setGeneratedSchedule(scheduleWithClientIdsAndNames);
            setDisplaySchedule(scheduleWithClientIdsAndNames);
            setWarnings(data.warnings || []);
            toast.success(`Schedule generated ${data.warnings?.length ? 'with warnings' : 'successfully'}.`, { id: tid, duration: 4000 });
           if (data.warnings?.length) {
    data.warnings.forEach((w: string) => toast(w, {
        duration: 6000,
        icon: '⚠️', // This adds the warning icon
    }));
}
        } catch (err) {
            console.error("Error in handleGenerateSchedule:", err);
            const message = err instanceof Error ? err.message : "Failed to generate schedule.";
            setError(message); toast.error(message, { id: tid, duration: 5000 });
            setGeneratedSchedule(null); setDisplaySchedule(null);
        } finally {
            setLoadingGeneration(false);
        }
    }, [startDate, endDate, pharmacyHours, scheduleRequirements, scheduleStaffList, manualStaffList, defaultLunchMinutes, minStaffingRules]);

    const handleReassignEmployee = (shiftId: string, newEmployeeId: string | null) => {
        setDisplaySchedule(prevSchedule => {
            if (!prevSchedule) return null;
           const newEmployee = newEmployeeId ? scheduleStaffList.find(emp => emp.id === newEmployeeId) : null;
            const originalShift = prevSchedule.find(s => s.id === shiftId);
            if (!originalShift) return prevSchedule;

           if (newEmployee && newEmployee.role !== originalShift.required_role) {
    toast.error(`Cannot assign ${newEmployee.name}. Role mismatch.`);
                setEditingShiftId(null); return prevSchedule;
            }
            return prevSchedule.map(shift => {
                if (shift.id === shiftId) {
                    const updatedNotes = `${shift.notes?.replace('(Manually reassigned)', '').trim() || ''} ${newEmployeeId ? '(Manually reassigned)' : ''}`.trim();
                    return {
                        ...shift, assigned_employee_id: newEmployeeId,
                        assigned_employee_name: newEmployee ? newEmployee.name : undefined,
                        is_unfilled: !newEmployeeId, notes: updatedNotes, is_manually_added: true,
                    };
                }
                return shift;
            });
        });
        setEditingShiftId(null);
        setShiftToEdit(null); // Close modal after reassigning
        toast.success("Assignment updated locally. Save changes to persist.");
    };

    const handleSaveChanges = useCallback(async () => {
        const currentDisplaySchedule = displaySchedule;
        if (!currentDisplaySchedule || currentDisplaySchedule.length === 0) { toast.error("No schedule data to save."); return; }
        if (!profile?.id) { toast.error("Employer profile not loaded."); return; }
        if (!scheduleName.trim()) { toast.error("Please enter a name for this schedule."); return; }
        if (!startDate || !endDate) { toast.error("Start and End date must be set."); return; }

        setSavingSchedule(true);
        const tid = toast.loading(`Saving schedule "${scheduleName}"...`);
        let currentScheduleId = savedScheduleId;

        try {
            const schedulePayload: Omit<ScheduleRecord, 'id' | 'created_at' | 'updated_at'> & { id?: string } = {
                employer_id: profile.id, schedule_name: scheduleName.trim(),
                period_start_date: startDate, period_end_date: endDate, status: 'draft',
            };

            if (currentScheduleId) {
                const { error: updateSchedError } = await supabase.from('schedules').update(schedulePayload).eq('id', currentScheduleId);
                if (updateSchedError) throw new Error(`Failed to update schedule: ${updateSchedError.message}`);
            } else {
                const { data: schedData, error: insertSchedError } = await supabase.from('schedules').insert(schedulePayload).select('id').single();
                if (insertSchedError) throw new Error(`Failed to create schedule: ${insertSchedError.message}`);
                if (!schedData?.id) throw new Error("Failed to get ID for created schedule.");
                currentScheduleId = schedData.id;
                setSavedScheduleId(currentScheduleId);
            }

            const shiftsToUpsert: Omit<ScheduleShiftRecord, 'id' | 'created_at' | 'updated_at'>[] = currentDisplaySchedule.map(dispShift => {
              const assignedStaffMember = scheduleStaffList.find(s => s.id === dispShift.assigned_employee_id);

    // We remove the client-side 'id' from every shift.
    // The database will generate a new, valid id for each one.
    const { id, ...shiftData } = dispShift; 
    return {
        schedule_id: currentScheduleId!,
        employer_id: profile.id,
        shift_date: shiftData.date,
        start_time: shiftData.start_time,
        end_time: shiftData.end_time,
        required_role: shiftData.required_role,
        assigned_staff_id: assignedStaffMember?.isManual ? assignedStaffMember.id : null,
        assigned_profile_id: assignedStaffMember && !assignedStaffMember.isManual ? assignedStaffMember.id : null,
        assigned_staff_name: shiftData.assigned_employee_name,
        is_unfilled: shiftData.is_unfilled,
        notes: shiftData.notes,
        published_shift_need_id: shiftData.published_shift_need_id,
    };
});

            if (currentScheduleId) {
                const { error: deleteOldShiftsError } = await supabase
                    .from('schedule_shifts')
                    .delete()
                    .eq('schedule_id', currentScheduleId);
                if (deleteOldShiftsError) {
                    console.warn("Could not delete old shifts, upsert might create duplicates or fail:", deleteOldShiftsError.message);
                }
            }

            if (shiftsToUpsert.length > 0) {
    // The 'id' and 'lunch' properties are already removed, so we can insert directly.
    const { error: shiftsError } = await supabase
        .from('schedule_shifts')
        .insert(shiftsToUpsert); 
    if (shiftsError) throw new Error(`Failed to save schedule shifts: ${shiftsError.message}`);
}

            const { data: refreshedShiftsData, error: fetchRefreshedError } = await supabase
                .from('schedule_shifts').select('*').eq('schedule_id', currentScheduleId!)
                .order('shift_date', { ascending: true }).order('start_time', { ascending: true });

            if (fetchRefreshedError) {
                console.error("Error fetching updated shifts after save:", fetchRefreshedError);
                toast.error(`Schedule "${scheduleName}" saved, but failed to refresh local data. Reload if issues persist.`, { id: tid, duration: 5000 });
            } else if (refreshedShiftsData) {
                const updatedDisplayShifts: GeneratedShift[] = refreshedShiftsData.map((sShift: ScheduleShiftRecord) => {
                    let staffName = sShift.assigned_staff_name;
                   if (!staffName && sShift.assigned_staff_id) {
    // Look in the main list first, then the old manual list as a fallback.
    const staffMember = scheduleStaffList.find(s => s.id === sShift.assigned_staff_id) || manualStaffList.find(ms => ms.id === sShift.assigned_staff_id);
    staffName = staffMember?.name || staffMember?.staff_name || 'Okänd personal';
}
                    return {
                        ...sShift,
                        id: sShift.id,
                        date: sShift.shift_date,
                        start_time: sShift.start_time,
                        end_time: sShift.end_time,
                        required_role: sShift.required_role as UserRole,
                        assigned_employee_id: sShift.assigned_staff_id,
                        assigned_employee_name: staffName,
                        is_unfilled: sShift.is_unfilled,
                        is_manually_added: true,
                    };
                });
                setDisplaySchedule(updatedDisplayShifts);
                setGeneratedSchedule(updatedDisplayShifts);
                toast.success(`Schedule "${scheduleName}" saved successfully! Data refreshed.`, { id: tid, duration: 4000 });
            } else {
                toast.success(`Schedule "${scheduleName}" saved. (No shifts returned for refresh)`, { id: tid, duration: 4000 });
            }
        } catch (err) {
            console.error("Error saving schedule:", err);
            const message = err instanceof Error ? err.message : "Failed to save schedule.";
            toast.error(message, { id: tid });
        } finally {
            setSavingSchedule(false);
        }
    }, [displaySchedule, profile?.id, scheduleName, startDate, endDate, savedScheduleId, manualStaffList]);

    const handlePublishUnfilled = useCallback(async () => {
        if (!savedScheduleId) { toast.error("Please save the schedule before publishing shifts."); return; }
        if (!displaySchedule || !profile?.id) {
            toast.error("No schedule data or profile found.");
            return;
        }

        const unfilledShifts = displaySchedule.filter(shift => shift.is_unfilled && !shift.published_shift_need_id);
        if (unfilledShifts.length === 0) { toast("No new unfilled shifts to publish."); return; }

        setPublishingShifts(true);
        const tid = toast.loading(`Publishing ${unfilledShifts.length} unfilled shifts...`);
        let publishedCount = 0; let errorCount = 0;
        const updatedShiftsLocally: GeneratedShift[] = JSON.parse(JSON.stringify(displaySchedule));

        try {
            for (const shift of unfilledShifts) {
                if (!shift.required_role || !shift.date || !shift.start_time || !shift.end_time) {
                    console.warn("Skipping invalid unfilled shift:", shift); errorCount++; continue;
                }
                const shiftPayload = {
                    p_title: shift.title || `${shift.required_role} Behövs`,
                    p_description: shift.description || `From schedule: ${scheduleName || 'Unnamed'}`,
                    p_date: shift.date,
                    p_start_time: shift.start_time,
                    p_end_time: shift.end_time,
                    p_required_experience: shift.required_experience ?? [],
                    p_status: 'open' as const,
                    p_location: shift.location || profile?.default_location || null,
                    p_required_role: shift.required_role,
                    p_is_urgent: shift.is_urgent ?? false,
                    p_urgent_pay_adjustment: shift.urgent_pay_adjustment ?? null,
                    p_hourly_rate: defaultHourlyRate, // Use the new default rate
                    p_lunch: `${defaultLunchMinutes} min`, // Use the existing lunch state

                };
                try {
                    const { data: rpcResult, error: createError } = await supabase.rpc('create_shift', shiftPayload);
                    if (createError) throw new Error(`RPC Error: ${createError.message}`);
                    if (!rpcResult || !rpcResult.id) throw new Error("Published but no ID returned from function.");

                    const { error: updateError } = await supabase.from('schedule_shifts')
                        .update({ published_shift_need_id: rpcResult.id })
                        .eq('id', shift.id);

                    if (updateError) {
                        console.warn(`Failed to link published shift to schedule_shift ${shift.id}: ${updateError.message}`);
                    } else {
                        const shiftIndex = updatedShiftsLocally.findIndex(s => s.id === shift.id);
                        if (shiftIndex !== -1) {
                            updatedShiftsLocally[shiftIndex].published_shift_need_id = rpcResult.id;
                        }
                    }
                    publishedCount++;
                } catch (individualError) {
                    console.error(`Failed to publish shift for ${shift.date} (${shift.required_role}):`, individualError);
                    errorCount++;
                }
            }
            setDisplaySchedule(updatedShiftsLocally);
            if (errorCount > 0) toast.error(`Published ${publishedCount} shifts, but ${errorCount} errors.`, { id: tid, duration: 6000 });
            else toast.success(`Successfully published ${publishedCount} unfilled shifts!`, { id: tid });

        } catch (err) {
            const message = err instanceof Error ? err.message : "Error publishing shifts.";
            toast.error(message, { id: tid });
        } finally {
            setPublishingShifts(false);
        }
    }, [displaySchedule, savedScheduleId, scheduleName, profile]);

    const handlePostSingleShift = useCallback(async (shiftToActuallyPost: GeneratedShift | null) => {
        if (!shiftToActuallyPost || !profile?.id) {
            toast.error("Shift data or profile missing.");
            return;
        }
        setPublishingShifts(true);
        const tid = toast.loading(`Posting shift for ${shiftToActuallyPost.required_role} on ${shiftToActuallyPost.date}...`);
        try {
            const shiftPayload = {
                p_title: postShiftTitle.trim() || `${shiftToActuallyPost.required_role} Behövs`,
                p_description: postShiftDescription.trim() || `From schedule: ${scheduleName || 'Unnamed'}`,
                p_date: shiftToActuallyPost.date,
                p_start_time: shiftToActuallyPost.start_time,
                p_end_time: shiftToActuallyPost.end_time,
                p_required_experience: shiftToActuallyPost.required_experience ?? [],
                p_status: 'open' as const,
                p_location: shiftToActuallyPost.location || profile?.default_location || null,
                p_required_role: shiftToActuallyPost.required_role,
                p_is_urgent: postShiftIsUrgent,
                p_urgent_pay_adjustment: postShiftIsUrgent ? (postShiftUrgentAdjustment || null) : null,
                p_hourly_rate: postShiftHourlyRate,
                p_lunch: postShiftLunch,
            };
            const { data: rpcResult, error: createError } = await supabase.rpc('create_shift', shiftPayload);
            if (createError) throw new Error(`Failed to post shift: ${createError.message}`);
            if (!rpcResult || !rpcResult.id) throw new Error("Shift posted but no ID returned from function.");

            const newShiftNeedId = rpcResult.id;

            setDisplaySchedule(prevSchedule => {
                if (!prevSchedule) return null;
                return prevSchedule.map(s => {
                    if (s.id === shiftToActuallyPost.id) {
                        return {
                            ...s, is_unfilled: true, assigned_employee_id: null, assigned_employee_name: undefined,
                            published_shift_need_id: newShiftNeedId, status: 'open',
                            notes: `${s.notes || ''} (Publicly posted: ${newShiftNeedId.substring(0,8)}...)`.trim(),
                            is_manually_added: true,
                        };
                    }
                    return s;
                });
            });

            if (savedScheduleId && shiftToActuallyPost.id.length === 36) {
                const { error: updateError } = await supabase.from('schedule_shifts')
                    .update({
                        published_shift_need_id: newShiftNeedId,
                        assigned_staff_id: null,
                        assigned_staff_name: null,
                        is_unfilled: true,
                        notes: `${shiftToActuallyPost.notes || ''} (Publicly posted: ${newShiftNeedId.substring(0,8)}...)`.trim()
                    })
                    .eq('id', shiftToActuallyPost.id);
                if (updateError) {
                    console.warn(`Failed to update schedule_shift ${shiftToActuallyPost.id} after posting: ${updateError.message}`);
                    toast.error("Shift posted, but failed to update schedule record fully. Please save changes.");
                }
            }

            toast.success(`Shift posted! ID: ${newShiftNeedId.substring(0,8)}. Remember to save schedule changes.`, { id: tid, duration: 5000 });
            setShowPostShiftModal(false); setShiftToPost(null);
        } catch (err) {
            console.error("Error posting single shift:", err);
            const message = err instanceof Error ? err.message : "Failed to post shift.";
            toast.error(message, { id: tid });
        } finally {
            setPublishingShifts(false);
        }
    }, [profile, scheduleName, postShiftTitle, , defaultHourlyRate, defaultLunchMinutes, postShiftDescription, postShiftIsUrgent, postShiftUrgentAdjustment, savedScheduleId]);

    const handleDownloadCsv = useCallback(() => {
        if (!displaySchedule || displaySchedule.length === 0) {
            toast.error("No schedule data to download.");
            return;
        }
        const headers = ["Date", "Day of Week", "Start Time", "End Time", "Role", "Assigned To", "Status", "Notes", "Published ID"];

        const sortedScheduleForCsv = [...displaySchedule].sort((a, b) => {
            if (a.date < b.date) return -1;
            if (a.date > b.date) return 1;
            if (a.start_time < b.start_time) return -1;
            if (a.start_time > b.start_time) return 1;
            return 0;
        });

        const csvRows = [
            headers.join(','),
            ...sortedScheduleForCsv.map(shift => {
                const dayOfWeek = isValid(parseISO(shift.date)) ? format(parseISO(shift.date), 'EEEE', { locale: sv }) : 'Invalid Date';
                const row = [
                    `"${shift.date}"`,
                    `"${dayOfWeek}"`,
                    `"${formatTime(shift.start_time)}"`,
                    `"${formatTime(shift.end_time)}"`,
                    `"${shift.required_role}"`,
                    `"${shift.assigned_employee_name || (shift.is_unfilled ? 'UNFILLED' : 'N/A')}"`,
                    `"${shift.published_shift_need_id ? `Posted (${shift.published_shift_need_id.substring(0,8)})` : (shift.is_unfilled ? 'Open' : 'Filled')}"`,
                    `"${(shift.notes || '').replace(/"/g, '""')}"`,
                    `"${shift.published_shift_need_id || ''}"`
                ];
                return row.join(',');
            })
        ];
        const csvString = csvRows.join('\n');
        const blob = new Blob([`\uFEFF${csvString}`], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');

        if (link.download !== undefined) {
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            const scheduleFileName = scheduleName ? scheduleName.replace(/[^a-z0-9_ .-]/gi, '_') : 'schedule';
            const datePart = startDate && endDate ? `${startDate}_to_${endDate}` : new Date().toISOString().split('T')[0];
            link.setAttribute('download', `${scheduleFileName}_${datePart}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            toast.success("Schedule CSV downloaded.");
        } else {
            toast.error("CSV download is not supported by your browser.");
        }
    }, [displaySchedule, scheduleName, startDate, endDate]);

    const groupedSchedule = useMemo(() => {
        if (!displaySchedule) return {};
        const grouped: Record<string, GeneratedShift[]> = {};
        const sortedForGrouping = [...displaySchedule].sort((a, b) => {
            if (a.date < b.date) return -1; if (a.date > b.date) return 1;
            if (a.start_time < b.start_time) return -1; if (a.start_time > b.start_time) return 1;
            return 0;
        });
        sortedForGrouping.forEach(shift => {
            if (!grouped[shift.date]) { grouped[shift.date] = []; }
            grouped[shift.date].push(shift);
        });
        return grouped;
    }, [displaySchedule]);

 const generateListPDF = async (toastId) => {
        if (!displaySchedule) {
            toast.error("No schedule data available.", { id: toastId });
            return;
        }
        
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const head = [['Datum', 'Tid', 'Roll', 'Tilldelad', 'Status', 'Noteringar']];
        const sortedSchedule = [...displaySchedule].sort((a, b) => {
            if (a.date < b.date) return -1; if (a.date > b.date) return 1;
            if (a.start_time < b.start_time) return -1; if (a.start_time > b.start_time) return 1;
            return 0;
        });

        const body = sortedSchedule.map(shift => {
            const statusText = shift.published_shift_need_id ? 'Publicerat' : (shift.is_unfilled ? 'Obemannat' : 'Tilldelad');
            return [
                format(parseISO(shift.date), 'yyyy-MM-dd (eee)', { locale: sv }),
                `${formatTime(shift.start_time)} - ${formatTime(shift.end_time)}`,
                ROLE_DISPLAY_MAP[shift.required_role] || shift.required_role,
                shift.assigned_employee_name || '---',
                statusText,
                shift.notes || ''
            ];
        });

        pdf.setFontSize(18);
        pdf.text(scheduleName || 'Generated Schedule', 14, 20);

        autoTable(pdf, {
            head: head, body: body, startY: 30, theme: 'grid',
            styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
            headStyles: { fillColor: [41, 128, 185], textColor: 255, fontStyle: 'bold' },
            columnStyles: { 5: { cellWidth: 'auto' } }
        });

        pdf.save(`schedule_list_${scheduleName || 'export'}.pdf`);
        toast.success("List PDF created successfully!", { id: toastId });
    };

    const generateCalendarPDF = async (calendarElement, toastId) => {
        html2canvas(calendarElement, { scale: 2, useCORS: true, backgroundColor: '#ffffff' })
            .then(canvas => {
                const imgData = canvas.toDataURL('image/png', 1.0);
                const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
                const pdfWidth = pdf.internal.pageSize.getWidth();
                const pdfHeight = pdf.internal.pageSize.getHeight();
                const margin = 10;
                const contentWidth = pdfWidth - margin * 2;
                const contentHeight = pdfHeight - margin * 2;
                const canvasAspectRatio = canvas.width / canvas.height;
                const contentAspectRatio = contentWidth / contentHeight;
                let finalWidth, finalHeight;
                if (canvasAspectRatio > contentAspectRatio) {
                    finalWidth = contentWidth;
                    finalHeight = contentWidth / canvasAspectRatio;
                } else {
                    finalHeight = contentHeight;
                    finalWidth = contentHeight * canvasAspectRatio;
                }
                const x = margin + (contentWidth - finalWidth) / 2;
                const y = margin + (contentHeight - finalHeight) / 2;
                pdf.addImage(imgData, 'PNG', x, y, finalWidth, finalHeight);
                pdf.save(`schedule_calendar_${scheduleName || 'export'}.pdf`);
                toast.success("Calendar PDF created successfully!", { id: toastId });
            }).catch(err => {
                console.error("Error creating calendar PDF:", err);
                toast.error("Failed to generate calendar PDF.", { id: toastId });
            });
    };

    const handleExportPDF = async () => {
        const toastId = toast.loading("Preparing PDF export...");
        if (scheduleView === 'list') {
            await generateListPDF(toastId);
        } else { // calendar view
            if (!calendarRef.current) {
                toast.error("Could not find the calendar element to export.", { id: toastId });
                return;
            }
            await generateCalendarPDF(calendarRef.current, toastId);
        }
    };

    const calendarEvents = useMemo(() => {
        if (!displaySchedule) return [];
        return displaySchedule.map(shift => ({
            id: shift.id,
            title: shift.is_unfilled ? `(${shift.required_role} - UNFILLED)` : `${shift.assigned_employee_name || 'N/A'} (${shift.required_role})`,
            start: `${shift.date}T${shift.start_time}`,
            end: `${shift.date}T${shift.end_time}`,
            backgroundColor: shift.is_unfilled ? '#FECACA' : (shift.published_shift_need_id ? '#BFDBFE' : '#A7F3D0'),
            borderColor: shift.is_unfilled ? '#F87171' : (shift.published_shift_need_id ? '#60A5FA' : '#34D399'),
            textColor: shift.is_unfilled ? '#B91C1C' : (shift.published_shift_need_id ? '#1E40AF' : '#065F46'),
            extendedProps: { shiftData: shift, type: 'generatedDisplayShift' },
            classNames: shift.is_unfilled ? ['fc-event-unfilled'] : (shift.published_shift_need_id ? ['fc-event-published'] : ['fc-event-filled'])
        }));
    }, [displaySchedule]);

    useEffect(() => {
        if (scheduleView !== 'calendar' || !calendarRef.current || !displaySchedule) {
            if (calendarInstanceRef.current) { calendarInstanceRef.current.destroy(); calendarInstanceRef.current = null; }
            return;
        }
        if (calendarInstanceRef.current) {
            calendarInstanceRef.current.setOption('events', calendarEvents);
            if (startDate && isValid(parseISO(startDate))) {
                calendarInstanceRef.current.gotoDate(parseISO(startDate));
            }
        } else {
            const calendar = new Calendar(calendarRef.current, {
                plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
                headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' },
                initialView: 'timeGridWeek',
                initialDate: startDate && isValid(parseISO(startDate)) ? startDate : undefined,
                locale: fcSvLocale,
                events: calendarEvents,
                height: 'auto',
                allDaySlot: false,
                slotMinTime: '06:00:00', slotMaxTime: '22:00:00',
                nowIndicator: true,
                eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
                slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
                eventDisplay: 'block',
                eventClick: function(info) {
                    const shiftClicked = info.event.extendedProps.shiftData as GeneratedShift;
                    setShiftToEdit(shiftClicked);
                },
                eventContent: function(arg) {
                    const shift = arg.event.extendedProps.shiftData as GeneratedShift;
                    const startTime = formatTime(shift.start_time);
                    const endTime = formatTime(shift.end_time);
                    const name = shift.is_unfilled ? '(UNFILLED)' : shift.assigned_employee_name || 'N/A';
                    const role = shift.required_role;
                    let html = `<div class="p-1 overflow-hidden text-xs fc-event-main-custom">`;
                    html += `<div class="font-semibold">${startTime} - ${endTime}</div>`;
                    html += `<div>${role}</div>`;
                    html += `<div class="font-medium ${shift.published_shift_need_id ? 'text-blue-900' : (shift.is_unfilled ? 'text-red-900' : 'text-green-950')}">${name}</div>`;
                    if (shift.published_shift_need_id) {
                        html += `<div class="text-xs italic text-blue-700">Posted</div>`;
                    }
                    html += `</div>`;
                    return { html: html };
                },
                eventMouseEnter: (info) => {
                    info.el.title = `${info.event.title}\n${formatTime(info.event.startStr)} - ${formatTime(info.event.endStr)}\n${(info.event.extendedProps.shiftData as GeneratedShift).notes || ''}`;
                },
            });
            calendar.render();
            calendarInstanceRef.current = calendar;
        }
        return () => {
            if (calendarInstanceRef.current && (!calendarRef.current || scheduleView !== 'calendar')) {
                calendarInstanceRef.current.destroy();
                calendarInstanceRef.current = null;
            }
        };
    }, [scheduleView, displaySchedule, calendarEvents, startDate]);

    const handlePrint = () => { window.print(); };

    const fetchSavedSchedules = useCallback(async () => {
        if (!profile?.id) return;
        setLoadingSavedSchedules(true);
        try {
            const { data, error } = await supabase
                .from('schedules')
                .select('*')
                .eq('employer_id', profile.id)
                .order('created_at', { ascending: false });
            if (error) throw error;
            setSavedSchedulesList(data || []);
        } catch (err) {
            console.error("Error fetching saved schedules:", err);
            toast.error(err instanceof Error ? err.message : "Failed to load saved schedules.");
            setSavedSchedulesList([]);
        } finally {
            setLoadingSavedSchedules(false);
        }
    }, [profile?.id]);

    useEffect(() => {
        if (profile?.id) {
            fetchSavedSchedules();
        }
    }, [profile?.id, fetchSavedSchedules]);

    const handleLoadSchedule = useCallback(async (scheduleToLoad: ScheduleRecord) => {
        if (!profile?.id || !scheduleToLoad.id) return;
        const tid = toast.loading(`Loading schedule "${scheduleToLoad.schedule_name}"...`);
        setError(null); setWarnings([]);
        try {
            const { data: shiftsData, error: shiftsError } = await supabase.from('schedule_shifts').select('*')
                .eq('schedule_id', scheduleToLoad.id).eq('employer_id', profile.id)
                .order('shift_date', { ascending: true }).order('start_time', { ascending: true });
            if (shiftsError) throw shiftsError;
            if (!shiftsData) throw new Error("No shifts found for this schedule.");

            const loadedDisplayShifts: GeneratedShift[] = shiftsData.map((sShift: ScheduleShiftRecord) => {
                let staffName = sShift.assigned_staff_name;
                if (!staffName && sShift.assigned_staff_id) {
                    const staffMember = manualStaffList.find(ms => ms.id === sShift.assigned_staff_id);
                    staffName = staffMember?.staff_name || 'Unknown Staff';
                }
                return {
                    id: sShift.id, date: sShift.shift_date, start_time: sShift.start_time, end_time: sShift.end_time,
                    required_role: sShift.required_role as UserRole, employer_id: sShift.employer_id,
                    title: `${sShift.required_role} Shift`, description: sShift.notes || `Loaded: ${scheduleToLoad.schedule_name}`,
                    location: profile?.default_location || null, status: sShift.is_unfilled ? 'open' : 'filled',
                    assigned_employee_id: sShift.assigned_staff_id, assigned_employee_name: staffName,
                    is_unfilled: sShift.is_unfilled, is_manually_added: true, notes: sShift.notes,
                    published_shift_need_id: sShift.published_shift_need_id,
                };
            });
            setScheduleName(scheduleToLoad.schedule_name);
            setStartDate(scheduleToLoad.period_start_date && isValid(parseISO(scheduleToLoad.period_start_date)) ? format(parseISO(scheduleToLoad.period_start_date), 'yyyy-MM-dd') : '');
            setEndDate(scheduleToLoad.period_end_date && isValid(parseISO(scheduleToLoad.period_end_date)) ? format(parseISO(scheduleToLoad.period_end_date), 'yyyy-MM-dd') : '');
            setSavedScheduleId(scheduleToLoad.id);
            setDisplaySchedule(loadedDisplayShifts); setGeneratedSchedule(loadedDisplayShifts);
            setShowLoadScheduleModal(false);
            toast.success(`Schedule "${scheduleToLoad.schedule_name}" loaded.`, { id: tid });
        } catch (err) {
            console.error("Error loading schedule:", err);
            const message = err instanceof Error ? err.message : "Failed to load schedule.";
            toast.error(message, { id: tid }); setError(message);
        }
    }, [profile?.id, profile?.default_location, manualStaffList]);

    const handleDeleteSchedule = useCallback(async (scheduleIdToDelete: string, scheduleNameToDelete: string) => {
        if (!profile?.id) return;
        if (!window.confirm(`Are you sure you want to permanently delete schedule "${scheduleNameToDelete}"? This cannot be undone.`)) return;
        const tid = toast.loading(`Deleting schedule "${scheduleNameToDelete}"...`);
        try {
            const { error: shiftsDelError } = await supabase.from('schedule_shifts').delete().eq('schedule_id', scheduleIdToDelete).eq('employer_id', profile.id);
            if (shiftsDelError && shiftsDelError.code !== 'PGRST116') { throw shiftsDelError; }

            const { error: schedDelError } = await supabase.from('schedules').delete().eq('id', scheduleIdToDelete).eq('employer_id', profile.id);
            if (schedDelError) throw schedDelError;

            toast.success(`Schedule "${scheduleNameToDelete}" deleted.`, { id: tid });
            fetchSavedSchedules();

            if (savedScheduleId === scheduleIdToDelete) {
                setScheduleName(''); setStartDate(''); setEndDate('');
                setDisplaySchedule(null); setGeneratedSchedule(null);
                setSavedScheduleId(null); setWarnings([]); setError(null);
            }
        } catch (err) {
            console.error("Error deleting schedule:", err);
            toast.error(err instanceof Error ? err.message : "Failed to delete schedule.", { id: tid });
        }
    }, [profile?.id, fetchSavedSchedules, savedScheduleId]);

  const handleUpdateShiftDetails = useCallback((updatedData: Partial<GeneratedShift>) => {
    if (!updatedData.id) {
        toast.error("Cannot update a shift without an ID.");
        return;
    }
    
    setDisplaySchedule(prevSchedule => {
        if (!prevSchedule) return null;
        return prevSchedule.map(shift => {
            if (shift.id === updatedData.id) {
                // Return a new object with the existing shift data merged with the updated data
                return { ...shift, ...updatedData, is_manually_added: true };
            }
            return shift;
        });
    });

    toast.success("Shift details updated locally. Remember to save the schedule.");
    setShowShiftDetailsModal(false);
    setShiftToEdit(null);
}, []);
    
    const availableStaffForShift = useMemo(() => {
    if (!shiftToEdit) return [];
    // Use the new unified list and property name
    return scheduleStaffList.filter(emp => emp.role === shiftToEdit.required_role);
}, [shiftToEdit, scheduleStaffList]);

    return (
        <div className="p-4 md:p-6 lg:p-8 space-y-6 bg-gray-50 min-h-screen">
            <h2 className="text-3xl font-bold text-gray-800 border-b pb-3 mb-6 print:hidden">Schemagenerator</h2>
            
            {/* Error and Warning messages */}
            {error && ( <div className="bg-red-100 border-l-4 border-red-500 text-red-700 px-4 py-3 rounded relative mb-4 shadow print:hidden" role="alert"> <strong className="font-bold block mb-1">Fel:</strong> <span className="block sm:inline">{error}</span> <button onClick={() => setError(null)} className="absolute top-0 bottom-0 right-0 px-4 py-3 text-red-500 hover:text-red-700"><X size={18}/></button> </div> )}
            {warnings.length > 0 && ( <div className="mb-4 bg-yellow-50 border-l-4 border-yellow-400 text-yellow-800 px-4 py-3 rounded-lg shadow print:hidden" role="alert"> <div className="flex items-center mb-1"> <AlertTriangle className="h-5 w-5 mr-2 text-yellow-600"/> <p className="font-bold">Varningar vid generering:</p> </div> <ul className="list-disc list-inside text-sm mt-1 pl-5"> {warnings.map((w, i) => <li key={i}>{w}</li>)} </ul> </div> )}

            {/* Configuration Sections - Grid Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 print:hidden">
                {/* --- Column 1: Period, Pharmacy Hours, General Rules --- */}
                <div className="space-y-6">
                    {/* Period Selection */}
                    <div className="card"> <h3 className="card-header"><CalendarIconLucide size={18} className="mr-2"/>1. Välj Period</h3> <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4"> <div><label htmlFor="startDate" className="label-style">Startdatum</label><input type="date" id="startDate" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="form-input" /></div> <div><label htmlFor="endDate" className="label-style">Slutdatum</label><input type="date" id="endDate" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate} className="form-input" /></div> </div> </div>
                    
                    {/* Pharmacy Hours */}
                    <div className="card"> <h3 className="card-header"><Clock size={18} className="mr-2"/>2. Ange Apotekets Öppettider</h3> 
                        <div className="space-y-3 p-4"> 
                            {pharmacyHours.map((day, index) => ( 
                                <div key={index} className="grid grid-cols-1 xs:grid-cols-[100px_1fr_1fr] sm:grid-cols-3 gap-2 items-center"> 
                                    <span className="text-sm font-medium xs:col-span-1">{DAYS_OF_WEEK_NAMES_SV[day.dayOfWeek]}</span> 
                                    <input type="time" aria-label={`${DAYS_OF_WEEK_NAMES_SV[day.dayOfWeek]} Öppettid`} value={day.openTime || ''} onChange={(e) => handlePharmacyHourChange(index, 'openTime', e.target.value || null)} className="form-input text-sm xs:col-span-1" /> 
                                    <input type="time" aria-label={`${DAYS_OF_WEEK_NAMES_SV[day.dayOfWeek]} Stängningstid`} value={day.closeTime || ''} onChange={(e) => handlePharmacyHourChange(index, 'closeTime', e.target.value || null)} className="form-input text-sm xs:col-span-1" /> 
                                </div> 
                            ))} 
                        </div> 
                    </div>
                    
                    {/* General Rules */}
                    <div className="card"> <h3 className="card-header"><Settings size={18} className="mr-2"/>3. Generella Regler</h3> 
                        <div className="p-4 space-y-4"> 
                            <div><label htmlFor="defaultLunchMinutes" className="label-style">Standard Lunchrast (minuter)</label><input type="number" id="defaultLunchMinutes" value={defaultLunchMinutes} onChange={(e) => setDefaultLunchMinutes(parseInt(e.target.value, 10) || 0)} className="form-input w-24" min="0" /></div> 
                          <div>
            <label htmlFor="defaultHourlyRate" className="label-style">Standard Timlön (kr)</label>
            <input 
                type="number" 
                id="defaultHourlyRate" 
                value={defaultHourlyRate} 
                onChange={(e) => setDefaultHourlyRate(parseInt(e.target.value, 10) || 0)} 
                className="form-input w-24" 
                min="0" 
            />
            <p className="text-xs text-gray-500 italic mt-1">Används vid masspublicering av pass.</p>
        </div>
                            <div> 
                                <div className="flex flex-wrap gap-2 justify-between items-center mb-2">
                                    <label className="label-style mb-0">Minimibemanning per Roll</label>
                                    <button onClick={handleAddMinStaffingRule} className="btn btn-secondary btn-xs"><Plus size={14} className="mr-1"/> Lägg till Regel</button>
                                </div> 
                                <p className="text-xs text-gray-500 italic mb-2">Minsta antal personal på plats under alla öppettider.</p> 
                                <div className="space-y-2"> 
                                    {minStaffingRules.length === 0 && <p className="text-xs text-gray-400">Inga regler för minimibemanning tillagda.</p>} 
                                    {minStaffingRules.map(rule => ( 
                                        <div key={rule.id} className="flex flex-wrap xs:flex-nowrap gap-2 items-center border-b pb-2"> 
                                            <select value={rule.role} onChange={(e) => handleMinStaffingChange(rule.id, 'role', e.target.value)} className="form-select text-xs p-1 flex-grow min-w-[100px]">
    <option value="" disabled>Välj Roll...</option>
    {ALL_ROLES.map(r => <option key={r} value={r}>{ROLE_DISPLAY_MAP[r]}</option>)}
</select>
                                            <input type="number" min="1" value={rule.count} onChange={(e) => handleMinStaffingChange(rule.id, 'count', e.target.value)} className="form-input text-xs p-1 w-16"/> 
                                            <button onClick={() => handleRemoveMinStaffingRule(rule.id)} className="text-red-500 hover:text-red-700 p-1 flex-shrink-0"><Trash2 size={14}/></button> 
                                        </div> 
                                    ))} 
                                </div> 
                            </div> 
                        </div> 
                    </div>
                </div>

                {/* --- Column 2: Staffing Needs, Staff Management --- */}
                <div className="space-y-6">
                    {/* Staffing Needs */}
                    <div className="card"> 
                        <div className="flex flex-wrap sm:flex-nowrap justify-between items-center card-header gap-2">
                            <h3 className="flex items-center"><Users size={18} className="mr-2"/>4. Definiera Personalbehov</h3>
                            <button onClick={handleAddRequirement} className="btn btn-secondary btn-xs flex-shrink-0"><Plus size={14} className="mr-1"/> Lägg till Behov</button>
                        </div> 
                        <div className="space-y-3 p-4 max-h-[400px] overflow-y-auto"> 
                            {scheduleRequirements.length === 0 && <p className="text-gray-500 italic text-center">Inga specifika personalbehov tillagda. Minimiregler kan fortfarande gälla.</p>} 
                            {scheduleRequirements.map((req) => ( 
                                <div key={req.id} className="border rounded p-4 bg-gray-50 relative shadow-sm space-y-3"> 
                                    <button type="button" onClick={() => handleRemoveRequirement(req.id)} className="absolute top-2 right-2 text-gray-400 hover:text-red-500 p-0.5 rounded-full hover:bg-red-100" aria-label="Ta bort Behov"><Trash2 size={14} /></button> 
                                    <div> 
                                        <label className="block text-sm font-medium text-gray-700 mb-1.5">Gäller för Dagar:</label> 
                                        <div className="flex flex-wrap gap-x-4 gap-y-2"> {DAYS_OF_WEEK_NAMES_SV.map((day, index) => ( <label key={index} className="flex items-center space-x-1.5 cursor-pointer text-sm"> <input type="checkbox" checked={req.daysOfWeek.includes(index)} onChange={() => handleRequirementChange(req.id, 'dayOfWeekToggle', index)} className="form-checkbox" /> <span>{day}</span> </label> ))} </div> 
                                        {req.daysOfWeek.length === 0 && <p className="text-red-600 text-xs mt-1">Välj minst en dag för detta behov.</p>} 
                                    </div> 
                                    <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 gap-3 pt-3 border-t mt-3"> 
                                        <div><label className="block text-xs font-medium text-gray-600">Starttid</label><input type="time" value={req.startTime} onChange={(e) => handleRequirementChange(req.id, 'startTime', e.target.value)} className="form-input text-sm p-1 mt-1 w-full" /></div> 
                                        <div><label className="block text-xs font-medium text-gray-600">Sluttid</label><input type="time" value={req.endTime} onChange={(e) => handleRequirementChange(req.id, 'endTime', e.target.value)} className="form-input text-sm p-1 mt-1 w-full" /></div> 
                                        <div>
    <label className="block text-xs font-medium text-gray-600">Roll</label>
    <select value={req.requiredRole} onChange={(e) => handleRequirementChange(req.id, 'requiredRole', e.target.value)} className="form-select text-sm p-1 mt-1 w-full">
        <option value="" disabled>Välj...</option>
        {ALL_ROLES.map(r => <option key={r} value={r}>{ROLE_DISPLAY_MAP[r]}</option>)}
    </select>
</div>
                                        <div><label className="block text-xs font-medium text-gray-600">Antal</label><input type="number" min="1" value={req.requiredCount} onChange={(e) => handleRequirementChange(req.id, 'requiredCount', e.target.value)} className="form-input text-sm p-1 mt-1 w-16" /></div> 
                                        <div className="col-span-1 xs:col-span-2 sm:col-span-1 flex items-center pt-2 sm:justify-end"> <input type="checkbox" id={`lunch-${req.id}`} checked={req.includeLunch} onChange={(e) => handleRequirementChange(req.id, 'includeLunch', e.target.checked)} className="form-checkbox mr-2"/> <label htmlFor={`lunch-${req.id}`} className="text-xs font-medium text-gray-600">Inkludera Lunch?</label> </div> 
                                    </div> 
                                </div> 
                            ))} 
                        </div> 
                    </div>
                    
                    {/* Staff Management */}
                    <div className="card"> <h3 className="card-header"><UserPlus size={18} className="mr-2"/>5. Hantera & Välj Personal</h3> 

                      {/* --- NEW BUTTON to open the employee modal --- */}
<div className="p-4 border-b">
    <button
        onClick={() => setIsStaffModalOpen(true)}
        className="btn btn-secondary w-full"
        disabled={employedStaffList.length === 0}
    >
        <UserCheck size={16} className="mr-2" />
        {employedStaffList.length > 0 ? "Lägg till från Mina Anställda" : "Inga anställda hittades"}
    </button>
</div>
                        <form onSubmit={handleAddStaffMember} className="p-4 border-b grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end"> 
                            <div><label htmlFor="newStaffName" className="label-style text-xs">Nytt Personalnamn</label><input type="text" id="newStaffName" value={newStaffName} onChange={(e) => setNewStaffName(e.target.value)} required className="form-input p-1 text-sm" placeholder="Namn på extern personal"/></div> 
                            <div>
    <label htmlFor="newStaffRole" className="label-style text-xs">Roll</label>
    <select id="newStaffRole" value={newStaffRole} onChange={(e) => setNewStaffRole(e.target.value as UserRole | '')} required className="form-select p-1 text-sm">
        <option value="" disabled>Välj Roll...</option>
        {ALL_ROLES.map(r => <option key={r} value={r}>{ROLE_DISPLAY_MAP[r]}</option>)}
    </select>
</div>
                            <button type="submit" className="btn btn-success btn-sm w-full sm:w-auto"><UserPlus size={16} className="mr-1"/> Lägg till</button> 
                        </form> 
                        <div className="p-4 space-y-3 max-h-[400px] overflow-y-auto">
    <h4 className="text-base font-medium text-gray-700">Personal som ska schemaläggas</h4>
    {scheduleStaffList.length === 0 ? (
        <p className="text-gray-500 italic text-center py-4">Ingen personal tillagd för detta schema.</p>
    ) : (
        scheduleStaffList.map((staff) => (
            <div key={staff.id} className="border rounded p-3 bg-white shadow-sm relative">
                {/* Remove button is now universal */}
                <button
                    type="button"
                    onClick={() => setScheduleStaffList(prev => prev.filter(s => s.id !== staff.id))}
                    className="absolute top-1 right-1 text-gray-400 hover:text-red-500 p-1 rounded-full"
                    aria-label="Ta bort från schema"
                >
                    <UserX size={14} />
                </button>

                <div className="font-medium mb-2">{staff.name} <span className="text-xs text-gray-500">({ROLE_DISPLAY_MAP[staff.role]})</span></div>

                {/* The new unified input fields */}
                <div className="pl-4 space-y-3 text-xs border-l ml-2 pt-2">
                    <div className="grid grid-cols-1 xs:grid-cols-2 gap-3">
                        <div>
                            {/* **UPDATED LABEL** */}
                            <label className="block font-medium text-gray-600 mb-1">Minsta Antal Timmar</label>
                            <input
                                type="number"
                                min="0"
                                placeholder="t.ex. 40"
                                value={staff.minstaAntalTimmar ?? ''}
                                onChange={(e) => handleStaffConstraintChange(staff.id, 'minstaAntalTimmar', e.target.value)}
                                className="form-input p-1 text-xs w-full"
                            />
                        </div>
                        <div>
                            <label className="block font-medium text-gray-600 mb-1">Anställningstyp</label>
                            <select
                                value={staff.anstallningstyp}
                                onChange={(e) => handleStaffConstraintChange(staff.id, 'anstallningstyp', e.target.value)}
                                className="form-select p-1 text-xs w-full"
                            >
                                <option value="Heltid">Heltid</option>
                                <option value="Deltid">Deltid</option>
                                <option value="Timmar">Timmar</option>
                            </select>
                        </div>
                    </div>
                    <div>
                        <label className="block font-medium text-gray-600 mb-1">Max Dagar i Rad</label>
                        <input
                            type="number"
                            min="1"
                            placeholder="t.ex. 5"
                            value={staff.maxConsecutiveDays ?? ''}
                            onChange={(e) => handleStaffConstraintChange(staff.id, 'maxConsecutiveDays', e.target.value)}
                            className="form-input p-1 text-xs w-20"
                        />
                    </div>
                </div>
            </div>
        ))
    )}
</div>
</div>     
 </div>
 </div>             

            {/* Action Buttons */}
            <div className="text-center mt-8 pt-6 border-t print:hidden flex flex-wrap justify-center gap-4">
                <button onClick={() => { fetchSavedSchedules(); setShowLoadScheduleModal(true); }} className="btn btn-secondary btn-lg" title="Ladda ett tidigare sparat schema"> <Download size={20} className="mr-2"/> Ladda Sparat Schema </button>
                <button 
                    onClick={handleGenerateSchedule} 
                    disabled={loadingGeneration || !startDate || !endDate || (scheduleRequirements.length === 0 && (!minStaffingRules.length || !minStaffingRules.some(r=>r.role && r.count >0))) || scheduleStaffList.length === 0}
                    className="btn btn-primary btn-lg"
                > 
                    {loadingGeneration ? <Loader2 className="animate-spin h-5 w-5 mr-2" /> : <Settings size={20} className="mr-2"/>} 
                    Generera Schema 
                </button>
            </div>

            {/* Schedule Results Section */}
            <div id="schedule-results" className="print:pt-0">
                {displaySchedule && (
                    <div className="card mt-8 print:shadow-none print:border-0 print:mt-0">
                        <div className="flex flex-wrap justify-between items-center gap-4 mb-4 border-b pb-3 p-4 print:hidden">
                            <div className="flex-grow min-w-[200px] w-full sm:w-auto">
                                <label htmlFor="scheduleName" className="label-style text-sm">Schemanamn (Krävs för att Spara)</label>
                                <input type="text" id="scheduleName" placeholder="t.ex., Vecka 21 Schema" value={scheduleName} onChange={(e) => setScheduleName(e.target.value)} className="form-input" disabled={savingSchedule}/>
                                {savedScheduleId && <p className="text-xs text-green-600 italic mt-1">Visar nu: {scheduleName}. Ändringar kräver ny sparning.</p>}
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <div className="flex space-x-1 bg-gray-200 p-1 rounded-lg">
                                    <button onClick={() => setScheduleView('list')} title="Listvy" className={`px-3 py-1 rounded-md text-sm ${scheduleView === 'list' ? 'bg-white shadow text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}> <List size={16}/> </button>
                                    <button onClick={() => setScheduleView('calendar')} title="Kalendervy" className={`px-3 py-1 rounded-md text-sm ${scheduleView === 'calendar' ? 'bg-white shadow text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}> <FullCalendarIcon size={16}/> </button>
                                </div>
                                <button onClick={handlePrint} className="btn btn-secondary btn-sm" title="Skriv ut Schemavy"> <Printer size={16} className="mr-1"/> Skriv ut </button>
                                <button onClick={handleDownloadCsv} className="btn btn-secondary btn-sm" disabled={!displaySchedule || displaySchedule.length === 0}> <Download size={16} className="mr-1"/> CSV </button>
                                <button onClick={handleExportPDF} className="btn btn-secondary btn-sm" disabled={!displaySchedule || displaySchedule.length === 0}>
                        <ImageIcon size={16} className="mr-1"/> PDF
                    </button>
                                <button onClick={handleSaveChanges} className="btn btn-success btn-sm" disabled={savingSchedule || !displaySchedule || displaySchedule.length === 0 || !scheduleName.trim()}> {savingSchedule ? <Loader2 className="animate-spin h-4 w-4 mr-1"/> : <Save size={16} className="mr-1"/>} {savingSchedule ? 'Sparar...' : (savedScheduleId ? 'Spara Ändringar' : 'Spara Schema')} </button>
                                {savedScheduleId && ( <button onClick={handlePublishUnfilled} className="btn btn-indigo btn-sm" disabled={publishingShifts || displaySchedule.filter(s => s.is_unfilled && !s.published_shift_need_id).length === 0}> {publishingShifts ? <Loader2 className="animate-spin h-4 w-4 mr-1"/> : <UploadCloud size={16} className="mr-1"/>} {publishingShifts ? 'Publicerar...' : `Publicera ${displaySchedule.filter(s => s.is_unfilled && !s.published_shift_need_id).length} Obemannade`} </button> )}
                            </div>
                        </div>
                        <div className="p-0 sm:p-4 print:p-0">
                            {displaySchedule.length === 0 && !loadingGeneration && <p className="text-center italic text-gray-500 py-4">Inga pass att visa.</p>}
                            {scheduleView === 'list' && displaySchedule.length > 0 && (
                                
                                  <div ref={listViewRef} className="space-y-6">
                                    {Object.entries(groupedSchedule).map(([date, shifts]) => (
                                    <div key={date} className="pdf-capture-item border rounded-lg overflow-hidden shadow-sm print:shadow-none print:border print:border-gray-300 print:break-inside-avoid">
                <h4 className="bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 border-b print:bg-gray-200">
                    {isValid(parseISO(date)) ? format(parseISO(date), 'EEEE, d MMMM', { locale: sv }) : 'Ogiltigt Datum'}
                </h4>
                <div className="divide-y print:divide-gray-300">                                       
                                                {shifts.map(shift => {
                                                    const availableStaffForRole = scheduleStaffList.filter(emp => emp.role === shift.required_role);
                                                    return (
                                                        <div key={shift.id} className={`px-3 py-3 grid grid-cols-1 md:grid-cols-6 gap-x-3 gap-y-2 items-center text-sm ${shift.published_shift_need_id ? 'bg-blue-50 hover:bg-blue-100' : (shift.is_unfilled ? 'bg-red-50 hover:bg-red-100 print:bg-transparent' : 'bg-white hover:bg-gray-50')}`}>
                                                            <div className="md:col-span-1 flex items-center text-gray-700"><Clock size={14} className="mr-1.5 text-gray-400 flex-shrink-0"/> {formatTime(shift.start_time)} - {formatTime(shift.end_time)}</div>
                                                           <div className="md:col-span-1 text-gray-600 font-medium">{ROLE_DISPLAY_MAP[shift.required_role] || shift.required_role}</div>
                                                            
                                                            <div className="md:col-span-2 relative print:hidden">
                                                                {editingShiftId === shift.id ? (
                                                                    <div className="flex items-center gap-2 flex-wrap">
                                                                        <select value={shift.assigned_employee_id || ''} onChange={(e) => handleReassignEmployee(shift.id, e.target.value || null)} className="form-select text-xs p-1 flex-grow min-w-[150px]">
                                                                            <option value="">-- Ej Tilldelad --</option>
                                                                            {availableStaffForRole.map(emp => (<option key={emp.id} value={emp.id}>{emp.name}</option>))}
                                                                        </select>
                                                                        <button onClick={() => setEditingShiftId(null)} className="text-gray-500 hover:text-gray-700 p-1 flex-shrink-0" title="Avbryt Omfördelning"><X size={14}/></button>
                                                                    </div>
                                                                ) : (
                                                                    <div className="flex items-center justify-between">
                                                                        {shift.published_shift_need_id ? 
                                                                            (<span className="font-semibold text-blue-700 flex items-center" title={`Publicerat: ${shift.published_shift_need_id}`}><Megaphone size={14} className="mr-1.5 flex-shrink-0"/> OFFENTLIGT PUBLICERAT</span>) :
                                                                            shift.is_unfilled ? 
                                                                            (<span className="font-semibold text-red-700 flex items-center"><UserX size={14} className="mr-1.5 flex-shrink-0"/> OBEMANNAT</span>) : 
                                                                            (<span className="font-medium text-gray-900 flex items-center"><UserCheck size={14} className="mr-1.5 text-green-600 flex-shrink-0"/> {shift.assigned_employee_name || 'Tilldelad'}</span>)
                                                                        }
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className="md:col-span-1 text-xs text-gray-500 italic truncate print:hidden" title={shift.notes || undefined}> {shift.notes} </div>
                                                            
                                                            <div className="md:col-span-1 flex items-center flex-wrap gap-1 justify-start md:justify-end print:hidden">
                                                                {!editingShiftId && !shift.published_shift_need_id && (
                                                                    <>
                                                                        {shift.is_unfilled ? 
                                                                            (<button onClick={() => setEditingShiftId(shift.id)} className="text-green-600 hover:text-green-800 text-xs p-1 rounded hover:bg-green-50" title="Tilldela Personal"><UserPlus size={14}/></button>) :
                                                                            (<button onClick={() => setEditingShiftId(shift.id)} className="text-blue-600 hover:text-blue-800 text-xs p-1 rounded hover:bg-blue-50" title="Omfördela Personal"><Repeat size={14}/></button>)
                                                                        }
                                                                        <button onClick={() => { setShiftToPost(shift); setPostShiftTitle(shift.title || `${shift.required_role} Pass`); setPostShiftDescription(shift.description || `Från schema: ${scheduleName || 'Namnlöst'}`); setPostShiftIsUrgent(shift.is_urgent || false); setPostShiftUrgentAdjustment(shift.urgent_pay_adjustment || null); setShowPostShiftModal(true);}}
                                                                                className="btn btn-indigo btn-xs" title="Publicera detta pass externt"
                                                                                disabled={!!shift.published_shift_need_id || publishingShifts}>
                                                                            <Megaphone size={14}/>
                                                                        </button>
                                                                    </>
                                                                )}
                                                                {editingShiftId === shift.id && (
                                                                    <button onClick={() => setEditingShiftId(null)} className="btn btn-secondary btn-xs">Avbryt</button>
                                                                )}
                                                            </div>
                                                            
                                                            <div className="md:col-span-3 hidden print:block"> {shift.published_shift_need_id ? `OFFENTLIGT PUBLICERAT (ID: ${shift.published_shift_need_id.substring(0,8)})` : shift.is_unfilled ? 'OBEMANNAT' : (shift.assigned_employee_name || 'Tilldelad')} </div>
                                                            <div className="md:col-span-1 hidden print:block text-xs text-gray-500 italic truncate" title={shift.notes || undefined}> {shift.notes} </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {scheduleView === 'calendar' && (
                                <div ref={calendarRef} className="schedule-calendar-container min-h-[70vh]">
                                    {( (displaySchedule && displaySchedule.length === 0) && !loadingGeneration) && <p className="text-center italic text-gray-500 py-4">Ingen schemadata att visa i kalendern.</p>}
                                </div>
                            )}
                            <div className="mt-6 pt-4 border-t text-center print:hidden"> <h4 className="font-medium text-sm mb-1 text-gray-600">Manuella Justeringar</h4> <p className="text-xs text-gray-500 italic">Klicka på ett pass i kalendern eller använd ikonerna i listvyn för att justera. Kom ihåg att spara ändringar.</p> </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Load Saved Schedule Modal */}
            {showLoadScheduleModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 print:hidden">
                    <div className="bg-white rounded-lg shadow-xl p-4 sm:p-6 w-full max-w-2xl max-h-[80vh] flex flex-col">
                        <div className="flex justify-between items-center border-b pb-3 mb-4">
                            <h3 className="text-xl font-semibold text-gray-800">Ladda Sparat Schema</h3>
                            <button onClick={() => setShowLoadScheduleModal(false)} className="text-gray-500 hover:text-gray-700 p-1 rounded-full" aria-label="Stäng modal"> <X size={20} /> </button>
                        </div>
                        {loadingSavedSchedules ? (
                            <div className="flex justify-center items-center py-10"> <Loader2 className="animate-spin h-8 w-8 text-blue-600" /> <p className="ml-3 text-gray-600">Laddar scheman...</p> </div>
                        ) : savedSchedulesList.length === 0 ? (
                            <p className="text-gray-500 italic text-center py-6">Inga scheman sparade ännu.</p>
                        ) : (
                            <div className="overflow-y-auto flex-grow">
                                <ul className="space-y-3">
                                    {savedSchedulesList.map(schedule => (
                                        <li key={schedule.id} className="border rounded-md p-3 hover:bg-gray-50 transition-colors">
                                            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                                                <div className="mb-2 sm:mb-0">
                                                    <p className="font-medium text-gray-800">{schedule.schedule_name}</p>
                                                    <p className="text-xs text-gray-500"> Period: {schedule.period_start_date && isValid(parseISO(schedule.period_start_date)) ? format(parseISO(schedule.period_start_date), 'd MMM yy', {locale: sv}) : 'N/A'} - {schedule.period_end_date && isValid(parseISO(schedule.period_end_date)) ? format(parseISO(schedule.period_end_date), 'd MMM yy', {locale: sv}) : 'N/A'} </p>
                                                    <p className="text-xs text-gray-500"> Sparad: {isValid(parseISO(schedule.created_at)) ? format(parseISO(schedule.created_at), 'd MMM yy HH:mm', {locale: sv}) : 'N/A'} </p>
                                                </div>
                                                <div className="flex items-center space-x-2 flex-shrink-0">
                                                    <button onClick={() => handleLoadSchedule(schedule)} className="btn btn-primary btn-xs" title="Ladda detta schema"> <UploadCloud size={14} className="mr-1" /> Ladda </button>
                                                    <button onClick={() => handleDeleteSchedule(schedule.id, schedule.schedule_name)} className="btn btn-danger btn-xs" title="Radera detta schema"> <Trash2 size={14} className="mr-1" /> Radera </button>
                                                </div>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                         <div className="border-t pt-4 mt-4 text-right"> <button onClick={() => setShowLoadScheduleModal(false)} className="btn btn-secondary"> Stäng </button> </div>
                    </div>
                </div>
            )}

            {/* Post Single Shift Modal */}
            {showPostShiftModal && shiftToPost && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 print:hidden">
                    <div className="bg-white rounded-lg shadow-xl p-4 sm:p-6 w-full max-w-lg">
                        <div className="flex justify-between items-center border-b pb-3 mb-4">
                            <h3 className="text-xl font-semibold text-gray-800">Publicera Pass Externt</h3>
                            <button onClick={() => {setShowPostShiftModal(false); setShiftToPost(null);}} className="text-gray-500 hover:text-gray-700 p-1 rounded-full"> <X size={20}/> </button>
                        </div>
                        <div className="space-y-4">
                            <p className="text-sm">
                                Publicerar: <strong>{shiftToPost.required_role}</strong> den <strong>{isValid(parseISO(shiftToPost.date)) ? format(parseISO(shiftToPost.date), 'EEEE, d MMMM', { locale: sv }) : 'Ogiltigt Datum'}</strong> ({formatTime(shiftToPost.start_time)} - {formatTime(shiftToPost.end_time)}).
                            </p>
                            {shiftToPost.assigned_employee_name && (
                                <p className="text-sm text-orange-600 bg-orange-50 p-2 rounded-md border border-orange-200">
                                    <Info size={14} className="inline mr-1 mb-0.5"/> Just nu tilldelad <strong>{shiftToPost.assigned_employee_name}</strong>. Publicering kommer att avboka hen och öppna passet för externa ansökningar.
                                </p>
                            )}
                            <div><label htmlFor="postShiftTitle" className="label-style">Rubrik för Publicering</label><input type="text" id="postShiftTitle" value={postShiftTitle} onChange={(e) => setPostShiftTitle(e.target.value)} className="form-input"/></div>
                          <div>
            <label htmlFor="postShiftHourlyRate" className="label-style">Timlön (kr)</label>
            <input 
                type="number" 
                id="postShiftHourlyRate" 
                value={postShiftHourlyRate ?? ''} 
                onChange={(e) => setPostShiftHourlyRate(e.target.value ? parseFloat(e.target.value) : null)} 
                className="form-input"
                placeholder="Ange timlön"
                required 
            />
        </div>
        <div>
            <label htmlFor="postShiftLunch" className="label-style">Lunch (t.ex. "30 min", "Obetald")</label>
            <input 
                type="text" 
                id="postShiftLunch" 
                value={postShiftLunch} 
                onChange={(e) => setPostShiftLunch(e.target.value)} 
                className="form-input"
                placeholder="t.ex. 30 min"
            />
        </div>
                            <div><label htmlFor="postShiftDescription" className="label-style">Beskrivning för Publicering</label><textarea id="postShiftDescription" value={postShiftDescription} onChange={(e) => setPostShiftDescription(e.target.value)} rows={2} className="form-input"/></div>
                            <div className="flex items-center"><input type="checkbox" id="postShiftUrgent" checked={postShiftIsUrgent} onChange={(e) => setPostShiftIsUrgent(e.target.checked)} className="form-checkbox mr-2"/><label htmlFor="postShiftUrgent" className="label-style mb-0">Markera som Brådskande</label></div>
                            {postShiftIsUrgent && (
                                <div><label htmlFor="postShiftUrgentAdjustment" className="label-style">Brådskande Lönetillägg (t.ex. 50)</label><input type="number" id="postShiftUrgentAdjustment" value={postShiftUrgentAdjustment ?? ''} onChange={(e) => setPostShiftUrgentAdjustment(e.target.value ? parseFloat(e.target.value) : null)} className="form-input w-full sm:w-1/2" placeholder="t.ex. 50 för +50kr/tim"/></div>
                            )}
                        </div>
                        <div className="border-t pt-4 mt-6 flex flex-wrap sm:flex-nowrap justify-end space-x-0 sm:space-x-3 gap-2 sm:gap-0">
                            <button onClick={() => {setShowPostShiftModal(false); setShiftToPost(null);}} className="btn btn-secondary w-full sm:w-auto">Avbryt</button>
                            <button onClick={() => handlePostSingleShift(shiftToPost)} className="btn btn-primary w-full sm:w-auto" disabled={publishingShifts}>
                                {publishingShifts ? <Loader2 className="animate-spin h-5 w-5 mr-2" /> : <UploadCloud size={16} className="mr-1"/>} Bekräfta & Publicera
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Calendar Action Modal */}
            {shiftToEdit && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
                        <div className="flex justify-between items-center border-b pb-3 mb-4">
                            <h3 className="text-xl font-semibold text-gray-800">Hantera Pass</h3>
                            <button onClick={() => setShiftToEdit(null)} className="text-gray-500 hover:text-gray-700 p-1 rounded-full"><X size={20} /></button>
                        </div>
                        <div className="space-y-4">
                            <p><strong>Datum:</strong> {format(parseISO(shiftToEdit.date), 'EEEE, d MMMM', { locale: sv })}</p>
                            <p><strong>Tid:</strong> {formatTime(shiftToEdit.start_time)} - {formatTime(shiftToEdit.end_time)}</p>
                            <p><strong>Roll:</strong> {shiftToEdit.required_role}</p>
                            <div>
                                <label htmlFor="reassign-select" className="label-style">Tilldela till:</label>
                                <select 
                                    id="reassign-select"
                                    value={shiftToEdit.assigned_employee_id || ''} 
                                    onChange={(e) => handleReassignEmployee(shiftToEdit.id, e.target.value || null)} 
                                    className="form-select w-full"
                                >
                                    <option value="">-- Markera som Obemannat --</option>
                                    {availableStaffForShift.map(emp => (<option key={emp.id} value={emp.id}>{emp.name}</option>))}
                                </select>
                            </div>
                            <div className="border-t pt-4 mt-4 flex justify-between items-center gap-3">
                                <button
                                    onClick={() => {
                                        setShowShiftDetailsModal(true);
                                    }}
                                    className="btn btn-secondary"
                                >
                                    <Edit size={16} className="mr-2"/>
                                    Redigera Detaljer
                                </button>
                                <div className="flex gap-3">
                                    <button 
                                        onClick={() => {
                                            setShiftToPost(shiftToEdit); 
                                            setShowPostShiftModal(true);
                                            setShiftToEdit(null);
                                        }} 
                                        className="btn btn-indigo"
                                        disabled={!!shiftToEdit.published_shift_need_id}
                                    >
                                        <Megaphone size={16} className="mr-2"/>
                                        {shiftToEdit.published_shift_need_id ? 'Redan Publicerat' : 'Publicera'}
                                    </button>
                                    <button onClick={() => setShiftToEdit(null)} className="btn btn-primary">Klar</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            
{showShiftDetailsModal && shiftToEdit && (
    <ShiftDetailsModal
        shift={shiftToEdit as unknown as ShiftNeed} // This cast is a sign of the problem, but we'll work with it.
        onClose={() => {
            setShowShiftDetailsModal(false);
            setShiftToEdit(null);
        }}
        onUpdate={(updatedData) => { // <-- **CHANGE THIS LINE AND THE LOGIC INSIDE**
            handleUpdateShiftDetails(updatedData); // <-- **USE THE NEW HANDLER**
        }}
        currentUserRole={profile?.role as UserRole | 'anonymous'}
    />
)}
                      {/* --- NEW: Modal for Selecting Employed Staff --- */}
{isStaffModalOpen && (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
        <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md max-h-[70vh] flex flex-col">
            <div className="flex justify-between items-center border-b pb-3 mb-4">
                <h3 className="text-xl font-semibold text-gray-800">Lägg till anställd i schemat</h3>
                <button onClick={() => setIsStaffModalOpen(false)} className="text-gray-500 hover:text-gray-700 p-1 rounded-full">
                    <X size={20} />
                </button>
            </div>
            <div className="overflow-y-auto flex-grow">
                <ul className="space-y-2">
                    {employedStaffList.map(emp => {
                        const isAlreadyAdded = scheduleStaffList.some(s => s.id === emp.id);
                        return (
                            <li key={emp.id}>
                                <button
                                    onClick={() => {
                                        if (isAlreadyAdded) {
                                            // Optional: remove if clicked again
                                            setScheduleStaffList(prev => prev.filter(s => s.id !== emp.id));
                                        } else {
                                            // Add the employee to the main schedule list
                                            const newScheduleMember: ScheduleStaffMember = {
                                                id: emp.id,
                                                name: emp.name,
                                                role: emp.role,
                                                minstaAntalTimmar: 40, // Default value
                                                anstallningstyp: 'Heltid', // Default value
                                                maxConsecutiveDays: 5, // Default value
                                                isManual: false,
                                            };
                                            setScheduleStaffList(prev => [...prev, newScheduleMember]);
                                        }
                                    }}
                                   className={`w-full text-left p-3 rounded-md transition-colors flex items-center ${isAlreadyAdded ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'}`}
                                >
                                    {isAlreadyAdded ? <CheckSquare size={16} className="mr-3 text-blue-600"/> : <Square size={16} className="mr-3 text-gray-400"/>}
                                    <div>
                                        <div className="font-medium">{emp.name}</div>
                                        <div className="text-sm text-gray-600">{ROLE_DISPLAY_MAP[emp.role]}</div>
                                    </div>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </div>
            <div className="border-t pt-4 mt-4 text-right">
                <button onClick={() => setIsStaffModalOpen(false)} className="btn btn-primary">Klar</button>
            </div>
        </div>
    </div>
)}

            <style jsx global>{`
                .card { @apply bg-white rounded-lg shadow-md border border-gray-200; }
                .card-header { @apply font-semibold text-lg text-gray-700 border-b px-4 py-3 bg-gray-50 rounded-t-lg flex items-center; }
                .label-style { @apply block text-sm font-medium text-gray-700 mb-1; }
                .form-input, .form-select { @apply block w-full px-3 py-1.5 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm disabled:bg-gray-100 disabled:cursor-not-allowed; }
                .form-checkbox { @apply h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 shrink-0; }
                .btn { @apply inline-flex items-center justify-center px-4 py-2 border text-sm font-medium rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 transition-colors duration-150 ease-in-out; }
                .btn-primary { @apply border-transparent text-white bg-blue-600 hover:bg-blue-700 focus:ring-blue-500; }
                .btn-secondary { @apply border-gray-300 text-gray-700 bg-white hover:bg-gray-50 focus:ring-indigo-500; }
                .btn-success { @apply border-transparent text-white bg-green-600 hover:bg-green-700 focus:ring-green-500; }
                .btn-danger { @apply border-transparent text-white bg-red-500 hover:bg-red-600 focus:ring-red-500; }
                .btn-indigo { @apply border-transparent text-white bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500; }
                .btn-xs { @apply px-2 py-1 text-xs; } .btn-sm { @apply px-2.5 py-1.5 text-xs; } .btn-lg { @apply px-6 py-3 text-base; }
                .schedule-calendar-container { @apply mt-4 p-0 md:p-4 bg-white rounded shadow border border-gray-200; }
                .fc { font-size: 0.875rem; } .fc .fc-toolbar-title { font-size: 1.1em; font-weight: 600; }
                .fc .fc-button { text-transform: capitalize; } .fc-event { border-radius: 4px; border-width: 1px; cursor: pointer; }
                .fc-event-unfilled { border-color: #F87171 !important; background-color: #FECACA !important; color: #B91C1C !important; }
                .fc-event-filled { border-color: #34D399 !important; background-color: #A7F3D0 !important; color: #065F46 !important; }
                .fc-event-published { border-color: #60A5FA !important; background-color: #BFDBFE !important; color: #1E40AF !important; }
                @media print {
                    body { background-color: white !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                    .print\\:hidden { display: none !important; } 
                    #schedule-results { padding-top: 0 !important; margin-top:0 !important; }
                    .card { box-shadow: none !important; border: 1px solid #ccc !important; margin-top: 0 !important; page-break-inside: avoid;}
                    .schedule-calendar-container { border: none !important; box-shadow: none !important; padding: 0 !important; margin-top: 0 !important; }
                    .fc-view-harness, .fc-scroller { height: auto !important; overflow: visible !important; }
                    .fc-toolbar { display: none !important; }
                    .fc-col-header { background-color: #f0f0f0 !important; }
                }
                .pdf-capture-mode .pdf-capture-item {
    border: none !important;
    box-shadow: none !important;
    border-radius: 0 !important;
    margin: 0 !important;
    padding: 1rem; /* Ensure consistent padding */
    background-color: #FFFFFF !important; /* Force a solid background */
}
.pdf-capture-item {
    page-break-inside: avoid;
    break-inside: avoid;
}
            `}</style>

         </div>              
        
    );
}