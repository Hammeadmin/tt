// src/components/employer/AddEmployeeModal.tsx
import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { Loader2, Save, X } from 'lucide-react';

interface AddEmployeeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onEmployeeAdded: () => void;
}

export const AddEmployeeModal: React.FC<AddEmployeeModalProps> = ({ isOpen, onClose, onEmployeeAdded }) => {
    const { profile: employerProfile } = useAuth();
    const [isLoading, setIsLoading] = useState(false);
    const [formData, setFormData] = useState({
        fullName: '', email: '', role: 'pharmacist', relationshipType: 'timkontrakt',
        phoneNumber: '', birthDate: '', address: '', postalCode: '', city: '', hourlyRate: ''
    });

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!employerProfile) return toast.error("Kunde inte identifiera arbetsgivare.");
        setIsLoading(true);

        const { data, error } = await supabase.rpc('create_and_link_employee', {
            p_full_name: formData.fullName,
            p_email: formData.email,
            p_role: formData.role,
            p_employer_id: employerProfile.id,
            p_relationship_type: formData.relationshipType,
            p_phone_number: formData.phoneNumber || null,
            p_birth_date: formData.birthDate || null,
            p_address: formData.address || null,
            p_postal_code: formData.postalCode || null,
            p_city: formData.city || null,
            p_hourly_rate: parseFloat(formData.hourlyRate) || null
        });

        setIsLoading(false);

        if (error || (data && !data.success)) {
            toast.error(`Misslyckades: ${error?.message || data?.message}`);
        } else {
            toast.success(`${formData.fullName} har lagts till och en inbjudan har skickats.`);
            onEmployeeAdded();
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
                <form onSubmit={handleSubmit}>
                    <div className="p-5 border-b flex justify-between items-center">
                        <h3 className="text-lg font-medium">Lägg till ny anställd</h3>
                        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
                    </div>
                    <div className="p-5 space-y-4 overflow-y-auto">
                        <h4 className="text-md font-semibold text-gray-700">Grundinformation</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div><label htmlFor="fullName" className="form-label">Fullständigt Namn*</label><input name="fullName" type="text" value={formData.fullName} onChange={handleChange} className="form-input" required /></div>
                            <div><label htmlFor="email" className="form-label">E-postadress*</label><input name="email" type="email" value={formData.email} onChange={handleChange} className="form-input" required /></div>
                            <div><label htmlFor="role" className="form-label">Roll*</label><select name="role" value={formData.role} onChange={handleChange} className="form-select"><option value="pharmacist">Farmaceut</option><option value="säljare">Säljare</option><option value="egenvårdsrådgivare">Egenvårdsrådgivare</option></select></div>
                            <div><label htmlFor="relationshipType" className="form-label">Anställningstyp*</label><select name="relationshipType" value={formData.relationshipType} onChange={handleChange} className="form-select"><option value="timkontrakt">Timanställd</option><option value="heltidsanställd">Heltidsanställd</option><option value="deltidskontrakt">Deltidsanställd</option></select></div>
                        </div>
                        <hr/>
                        <h4 className="text-md font-semibold text-gray-700">Kontakt & Löneinformation</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div><label htmlFor="birthDate" className="form-label">Födelsedatum</label><input name="birthDate" type="date" value={formData.birthDate} onChange={handleChange} className="form-input" /></div>
                            <div><label htmlFor="phoneNumber" className="form-label">Telefonnummer</label><input name="phoneNumber" type="tel" value={formData.phoneNumber} onChange={handleChange} className="form-input" /></div>
                            <div><label htmlFor="address" className="form-label">Adress</label><input name="address" type="text" value={formData.address} onChange={handleChange} className="form-input" /></div>
                            <div><label htmlFor="postalCode" className="form-label">Postnummer</label><input name="postalCode" type="text" value={formData.postalCode} onChange={handleChange} className="form-input" /></div>
                            <div><label htmlFor="city" className="form-label">Stad</label><input name="city" type="text" value={formData.city} onChange={handleChange} className="form-input" /></div>
                            <div><label htmlFor="hourlyRate" className="form-label">Timlön (SEK)</label><input name="hourlyRate" type="number" step="0.01" value={formData.hourlyRate} onChange={handleChange} className="form-input" placeholder="ex. 350.00" /></div>
                        </div>
                    </div>
                    <div className="p-4 bg-gray-50 border-t flex justify-end items-center space-x-2">
                        <button type="button" onClick={onClose} className="btn btn-outline">Avbryt</button>
                        <button type="submit" disabled={isLoading} className="btn btn-primary">{isLoading ? <Loader2 className="animate-spin"/> : <Save/>} Spara och Bjud In</button>
                    </div>
                </form>
            </div>
        </div>
    );
};