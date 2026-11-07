"""
Clinic Voice Agent Domain Logic
Contains clinic knowledge base and dialogue manager for patient interactions.
"""

from .knowledge_base import CLINIC_DATA, get_doctor_info, get_clinic_hours
from .conversation import ClinicDialogueManager

__all__ = ["CLINIC_DATA", "get_doctor_info", "get_clinic_hours", "ClinicDialogueManager"]
